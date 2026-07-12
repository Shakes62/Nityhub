import dotenv from "dotenv"
import { fileURLToPath } from "url"
import path from "path"
import fs from "fs"
import admin from "firebase-admin"

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function parseFirebaseServiceAccount(value) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(String(value).replace(/^﻿/, ""))
    if (parsed?.private_key && typeof parsed.private_key === "string") {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n")
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid FIREBASE service account JSON: ${error.message}`)
  }
}

function resolveFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return parseFirebaseServiceAccount(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, "base64").toString("utf8")
    return parseFirebaseServiceAccount(decoded)
  }

  const configuredPath = String(process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "").trim()
  // The service account key historically lived next to server.js (project root),
  // one level up from this src/ module.
  const fallbackPath = path.join(__dirname, "..", "serviceAccountKey.json")
  const candidatePaths = [configuredPath, fallbackPath].filter(Boolean)

  for (const candidate of candidatePaths) {
    const resolvedPath = path.isAbsolute(candidate) ? candidate : path.resolve(__dirname, "..", candidate)
    if (!fs.existsSync(resolvedPath)) {
      continue
    }

    const fileText = fs.readFileSync(resolvedPath, "utf8")
    const parsed = parseFirebaseServiceAccount(fileText)
    if (parsed) {
      return parsed
    }
  }

  throw new Error(
    "Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, or FIREBASE_SERVICE_ACCOUNT_PATH.",
  )
}

function resolveFirebaseDatabaseUrl(serviceAccount) {
  const configured =
    String(process.env.FIREBASE_DATABASE_URL || process.env.FIREBASE_DB_URL || serviceAccount?.databaseURL || "").trim()
  if (configured) {
    return configured
  }

  const projectId = String(serviceAccount?.project_id || "").trim()
  return projectId ? `https://${projectId}-default-rtdb.firebaseio.com` : ""
}

const firebaseServiceAccount = resolveFirebaseServiceAccount()
const firebaseDatabaseUrl = resolveFirebaseDatabaseUrl(firebaseServiceAccount)

if (!firebaseDatabaseUrl) {
  throw new Error("Missing Firebase Realtime Database URL. Set FIREBASE_DATABASE_URL or include it in the service account config.")
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount),
    databaseURL: firebaseDatabaseUrl,
  })
}

export { admin }
export const db = admin.database()
