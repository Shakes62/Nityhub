// Drop-in replacement for src/firebase.js under test (see register.js).
//
// Auth: an ID token of the form "test:<uid>[:<email>]" verifies as that user;
// anything else is rejected, like a forged or expired token would be.
// Messaging: pushes are recorded instead of sent.

import { FakeDatabase } from "./fake-rtdb.js"

export const db = new FakeDatabase()

export const sentPushes = []

export const admin = {
  auth: () => ({
    async verifyIdToken(token) {
      const match = /^test:([A-Za-z0-9_-]+)(?::(.+))?$/.exec(String(token || ""))
      if (!match) throw new Error("Invalid token")
      return { uid: match[1], email: match[2] || `${match[1]}@example.com` }
    },
    async deleteUser() {},
  }),
  messaging: () => ({
    async send(message) {
      sentPushes.push(message)
      return "message-id"
    },
    async sendEachForMulticast(message) {
      sentPushes.push(message)
      return { successCount: message.tokens.length, failureCount: 0, responses: message.tokens.map(() => ({ success: true })) }
    },
  }),
  database: () => db,
}
