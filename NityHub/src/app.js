import express from "express"

import { installBaseMiddleware } from "./middleware.js"
import { registerRoutes } from "./routes.js"

/**
 * Build the Express app: middleware and every route, but no timers and no
 * listen(). server.js adds the process-level concerns; integration tests use
 * this directly against an in-memory database.
 */
export function createApp() {
  const app = express()
  app.disable("x-powered-by")
  installBaseMiddleware(app)
  registerRoutes(app)
  return app
}
