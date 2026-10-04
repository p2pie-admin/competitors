import { timingSafeEqual } from "crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const adminGuard = (token: string | undefined) => async (req: FastifyRequest, reply: FastifyReply) => {
  if (!token) return reply.code(503).send({ error: "admin API disabled (COMPETITORS_ADMIN_TOKEN not set)" });
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: "unauthorized" });
};
