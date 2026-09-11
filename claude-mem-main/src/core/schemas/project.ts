// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  slug: z.string().trim().min(1).nullable().default(null),
  rootPath: z.string().trim().min(1).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAtEpoch: z.number().int().nonnegative(),
  updatedAtEpoch: z.number().int().nonnegative()
});

export const CreateProjectSchema = ProjectSchema.omit({
  id: true,
  createdAtEpoch: true,
  updatedAtEpoch: true
}).partial({
  slug: true,
  rootPath: true,
  metadata: true
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
export type CreateProject = z.infer<typeof CreateProjectSchema>;
