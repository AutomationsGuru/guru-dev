import type { SkillDraft } from '../types/skillDraft';
import type { Experience } from '../types/experience';

/**
 * skillFromExperience
 *
 * Pure function that produces a SkillDraft (status: 'draft') from an Experience.
 * This is the core of Skill-from-Experience (SKXP) capability.
 *
 * Always returns status: 'draft' (never auto-approves; governed self-mutation
 * remains review-and-approval gated).
 *
 * Pure function: no I/O, no side effects, no mutation of inputs.
 * Deterministic: same Experience always yields structurally equivalent draft
 * (modulo createdAt timestamp).
 *
 * Derives name and description from the trace and outcome for minimal viable
 * draft. If trace is empty, still returns a valid minimal draft.
 *
 * @param experience - Execution trace + outcome to derive skill from
 * @returns SkillDraft ready for review/approval
 */
export function skillFromExperience(experience: Experience): SkillDraft {
  const trace = experience.trace?.trim() || '';
  const firstLine = trace.split('\n')[0] || 'Unnamed experience';
  const success = experience.outcome?.success ?? false;
  const metrics = experience.outcome?.metrics;

  const name = `Skill from ${firstLine.substring(0, 50)}${firstLine.length > 50 ? '...' : ''}`;

  let description = `Auto-generated skill draft based on experience trace (success=${success}). `;
  if (trace) {
    description += `Trace: ${trace.substring(0, 120)}${trace.length > 120 ? '...' : ''}`;
  } else {
    description += 'No trace provided.';
  }
  if (experience.context) {
    description += ` Context: ${experience.context}.`;
  }
  if (metrics && Object.keys(metrics).length > 0) {
    description += ` Metrics: ${JSON.stringify(metrics)}.`;
  }

  return {
    id: `draft-${experience.id}`,
    name,
    description,
    status: 'draft',
    source: 'trace',
    createdAt: new Date().toISOString(),
  };
}
