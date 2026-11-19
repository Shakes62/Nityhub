// A small in-memory stand-in for the firebase-admin Realtime Database, used by
// the integration tests to boot the real Express app without a network or
// credentials. It implements exactly the surface this codebase uses: refs,
// once/set/update/remove/push/transaction, value and child_added listeners,
// and orderByChild/orderByKey queries with startAt/endAt/equalTo/limits.
//
// Semantics follow RTDB where it matters for correctness tests: writing null
// deletes, empty objects vanish, transactions abort on undefined, and every
// write notifies the listeners on affected paths.

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

const splitPath = (path) => String(path || "").split("/").filter(Boolean)

function prune(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) {
    const out = value.map(prune)
    return out.some((item) => item !== null) ? out : null
  }
  if (typeof value === "object") {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      const next = prune(child)
      if (next !== null) out[key] = next
    }
    return Object.keys(out).length ? out : null
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null
  return value
}

let pushCounter = 0
function pushKey() {
  pushCounter += 1
  return `-N${Date.now().toString(36).padStart(9, "0")}${String(pushCounter).padStart(6, "0")}`
}

function compareValues(a, b) {
  const rank = (v) => (v === null || v === undefined ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : typeof v === "string" ? 3 : 4)
  const ra = rank(a)
  const rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 2 || ra === 3) return a < b ? -1 : a > b ? 1 : 0
  if (ra === 1) return Number(a) - Number(b)
  return 0
}

class Snapshot {
  constructor(key, value, ordered = null) {
    this.key = key
    this._value = value === undefined ? null : value
    this._ordered = ordered
  }
  val() { return clone(this._value) }
  exists() { return this._value !== null && this._value !== undefined }
  child(path) {
    let node = this._value
    for (const part of splitPath(path)) node = node && typeof node === "object" ? node[part] : null
    const parts = splitPath(path)
    return new Snapshot(parts[parts.length - 1] || this.key, node ?? null)
  }
  numChildren() { return this._value && typeof this._value === "object" ? Object.keys(this._value).length : 0 }
  forEach(cb) {
    const entries = this._ordered || Object.entries(this._value && typeof this._value === "object" ? this._value : {})
    for (const [key, value] of entries) {
      if (cb(new Snapshot(key, value)) === true) return true
    }
    return false
  }
}

class Query {
  constructor(db, parts, spec = {}) {
    this._db = db
    this._parts = parts
    this._spec = spec
  }
  get key() { return this._parts.length ? this._parts[this._parts.length - 1] : null }
  _with(patch) { return new Query(this._db, this._parts, { ...this._spec, ...patch }) }
  orderByChild(child) { return this._with({ orderBy: "child", child }) }
  orderByKey() { return this._with({ orderBy: "key" }) }
  orderByValue() { return this._with({ orderBy: "value" }) }
  startAt(value) { return this._with({ startAt: value }) }
  endAt(value) { return this._with({ endAt: value }) }
  equalTo(value) { return this._with({ startAt: value, endAt: value }) }
  limitToFirst(n) { return this._with({ limitToFirst: n }) }
  limitToLast(n) { return this._with({ limitToLast: n }) }
  _isQuery() {
    const s = this._spec
    return Boolean(s.orderBy || s.startAt !== undefined || s.endAt !== undefined || s.limitToFirst || s.limitToLast)
  }
  _orderedEntries() {
    const raw = this._db._get(this._parts)
    if (!raw || typeof raw !== "object") return []
    const s = this._spec
    const sortValue = ([key, value]) => (s.orderBy === "child"
      ? splitPath(s.child).reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), value) ?? null
      : s.orderBy === "value" ? value : key)
    let entries = Object.entries(raw).map((entry) => [entry, sortValue(entry)])
    entries.sort((a, b) => compareValues(a[1], b[1]) || (a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : 0))
    if (s.startAt !== undefined) entries = entries.filter(([, v]) => compareValues(v, s.startAt) >= 0)
    if (s.endAt !== undefined) entries = entries.filter(([, v]) => compareValues(v, s.endAt) <= 0)
    if (s.limitToFirst) entries = entries.slice(0, s.limitToFirst)
    if (s.limitToLast) entries = entries.slice(-s.limitToLast)
    return entries.map(([entry]) => entry)
  }
  _snapshot() {
    if (!this._isQuery()) return new Snapshot(this.key, clone(this._db._get(this._parts)))
    const ordered = this._orderedEntries()
    const value = ordered.length ? Object.fromEntries(ordered.map(([k, v]) => [k, clone(v)])) : null
    return new Snapshot(this.key, value, ordered.map(([k, v]) => [k, clone(v)]))
  }
  async once(event = "value") {
    if (event !== "value") throw new Error(`fake-rtdb: once(${event}) not supported`)
    await this._db._tick()
    return this._snapshot()
  }
  on(event, cb, errorCb) {
    const listener = { query: this, event, cb, errorCb, known: new Set(), lastKey: undefined }
    if (event === "child_added") {
      for (const [key, value] of this._orderedEntries()) {
        listener.known.add(key)
        queueMicrotask(() => cb(new Snapshot(key, clone(value))))
      }
    } else if (event === "value") {
      const snap = this._snapshot()
      listener.lastKey = JSON.stringify(snap._value)
      queueMicrotask(() => cb(snap))
    } else {
      throw new Error(`fake-rtdb: on(${event}) not supported`)
    }
    this._db._listeners.add(listener)
    return cb
  }
  off(event, cb) {
    for (const listener of this._db._listeners) {
      if (listener.query._parts.join("/") === this._parts.join("/") && (!event || listener.event === event) && (!cb || listener.cb === cb)) {
        this._db._listeners.delete(listener)
      }
    }
  }
}

class Reference extends Query {
  constructor(db, parts) { super(db, parts, {}) }
  get ref() { return this }
  get parent() { return this._parts.length ? new Reference(this._db, this._parts.slice(0, -1)) : null }
  child(path) { return new Reference(this._db, [...this._parts, ...splitPath(path)]) }
  async set(value) {
    await this._db._tick()
    this._db._write(this._parts, value)
  }
  async update(values) {
    await this._db._tick()
    for (const [path, value] of Object.entries(values || {})) {
      this._db._write([...this._parts, ...splitPath(path)], value, { notify: false })
    }
    this._db._notify()
  }
  async remove() {
    await this._db._tick()
    this._db._write(this._parts, null)
  }
  push(value) {
    const ref = this.child(pushKey())
    if (value !== undefined) {
      const promise = ref.set(value)
      ref.then = promise.then.bind(promise)
    }
    return ref
  }
  async transaction(updater) {
    await this._db._tick()
    const current = clone(this._db._get(this._parts))
    const next = updater(current === undefined ? null : current)
    if (next === undefined) {
      return { committed: false, snapshot: new Snapshot(this.key, clone(this._db._get(this._parts))) }
    }
    this._db._write(this._parts, next)
    return { committed: true, snapshot: new Snapshot(this.key, clone(this._db._get(this._parts))) }
  }
}

export class FakeDatabase {
  constructor() {
    this._root = null
    this._listeners = new Set()
  }
  ref(path = "") { return new Reference(this, splitPath(path)) }
  /** Replace all data. Listeners are kept: long-lived module syncs stay attached. */
  reset(data = null) {
    this._root = prune(clone(data))
    this._notify()
  }
  dump() { return clone(this._root) }
  get(path) { return clone(this._get(splitPath(path))) }
  async _tick() { await Promise.resolve() }
  _get(parts) {
    let node = this._root
    for (const part of parts) {
      if (!node || typeof node !== "object") return null
      node = node[part]
    }
    return node === undefined ? null : node
  }
  _write(parts, value, { notify = true } = {}) {
    const next = prune(clone(value))
    if (!parts.length) {
      this._root = next
    } else {
      if (!this._root || typeof this._root !== "object") this._root = {}
      let node = this._root
      for (const part of parts.slice(0, -1)) {
        if (!node[part] || typeof node[part] !== "object") node[part] = {}
        node = node[part]
      }
      const last = parts[parts.length - 1]
      if (next === null) delete node[last]
      else node[last] = next
      this._root = prune(this._root)
    }
    if (notify) this._notify()
  }
  _notify() {
    for (const listener of [...this._listeners]) {
      if (!this._listeners.has(listener)) continue
      const { query, event, cb } = listener
      if (event === "value") {
        const snap = query._snapshot()
        const key = JSON.stringify(snap._value)
        if (listener.lastKey === key) continue
        listener.lastKey = key
        queueMicrotask(() => cb(snap))
      } else if (event === "child_added") {
        for (const [key, value] of query._orderedEntries()) {
          if (listener.known.has(key)) continue
          listener.known.add(key)
          queueMicrotask(() => cb(new Snapshot(key, clone(value))))
        }
      }
    }
  }
}
