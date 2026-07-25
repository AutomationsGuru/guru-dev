import { z } from 'zod';

export const ToolPermissionClass = z.enum([
  'read-only',
  'write',
  'shell-risk',
  'hard-limit',
]);
export type ToolPermissionClass = z.infer<typeof ToolPermissionClass>;

export const ApprovalProfileName = z.enum([
  'plan-read-only',
  'accept-edits',
  'default-ask',
  'auto-approve',
]);
export type ApprovalProfileName = z.infer<typeof ApprovalProfileName>;

export const APPROVAL_PROFILE_MAP: Record<
  ApprovalProfileName,
  ToolPermissionClass[]
> = {
  'plan-read-only': ['read-only'],
  'accept-edits': ['read-only', 'write'],
  'default-ask': ['read-only'],
  'auto-approve': ['read-only', 'write', 'shell-risk'],
};
