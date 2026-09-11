// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const ServerSessionStatusSchema = z.enum(['active', 'completed', 'failed']);

export const ServerSessionSchema = z.object({
  id: z.string().trim().min(1),
  projectId: z.string().trim().min(1),
  contentSessionId: z.string().trim().min(1).nullable().default(null),
  memorySessionId: z.string().trim().min(1).nullable().default(null),
  platformSource: z.string().trim().min(1).default('claude'),
  title: z.string().trim().min(1).nullable().default(null),
  status: ServerSessionStatusSchema.default('active'),
  metadata: z.record(z.string(), z.unknown()).default({}),
  startedAtEpoch: z.number().int().nonnegative(),
  completedAtEpoch: z.number().int().nonnegative().nullable().default(null),
  updatedAtEpoch: z.number().int().nonnegative()
});

export const CreateServerSessionSchema = ServerSessionSchema.omit({
  id: true,
  startedAtEpoch: true,
  status: true,
  completedAtEpoch: true,
  updatedAtEpoch: true
}).partial({
  contentSessionId: true,
  memorySessionId: true,
  platformSource: true,
  title: true,
  metadata: true
}).strict();

export type ServerSessionStatus = z.infer<typeof ServerSessionStatusSchema>;
export type ServerSession = z.infer<typeof ServerSessionSchema>;
export type CreateServerSession = z.infer<typeof CreateServerSessionSchema>;
