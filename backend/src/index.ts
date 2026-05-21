import Fastify from "fastify";
import fastifyCors from "@fastify/cors";

import { runDatasetAgentFromEnv } from "./dataset-agent/index.js";
import { env } from "./env.js";
import clerkAuthPlugin from "./clerk-auth.js";

const fastify = Fastify({ logger: true });

await fastify.register(fastifyCors, {
  origin: env.CLIENT_ORIGIN,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  credentials: true,
  maxAge: 86400,
});

// Make `fastify.clerk` available and warn on missing CLERK_SECRET_KEY.
// `requireAuth` (also exported from ./clerk-auth) is the preHandler for
// protected routes — see the example block below.
await fastify.register(clerkAuthPlugin);

// ────────────────────────────────────────────────────────────────────────
//  Public routes
// ────────────────────────────────────────────────────────────────────────

fastify.get("/health", async () => ({ status: "ok" }));

fastify.post<{
  Body: {
    prompt?: string;
    promptId?: string;
    promptQuality?: string;
    requiredColumns?: string[];
  };
}>("/dataset-agent/run", async (request, reply) => {
  const prompt = request.body.prompt?.trim();
  if (!prompt) {
    return reply.code(400).send({ error: "prompt is required" });
  }

  const requiredColumns = request.body.requiredColumns?.length
    ? request.body.requiredColumns
    : ["entity_name", "source_url"];

  return runDatasetAgentFromEnv({
    prompt,
    promptId: request.body.promptId,
    promptQuality: request.body.promptQuality,
    requiredColumns,
  });
});

// ────────────────────────────────────────────────────────────────────────
//  Protected routes — gated by Clerk JWT verification
//
//  When user-facing endpoints are added (e.g. manual refresh trigger),
//  register them inside this scope. Example:
//
//    await fastify.register(async (instance) => {
//      instance.addHook("preHandler", requireAuth);
//      instance.get("/me", async (req) => req.auth);
//    });
//
//  No protected routes exist yet, so the scope is intentionally empty.
// ────────────────────────────────────────────────────────────────────────

try {
  await fastify.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
