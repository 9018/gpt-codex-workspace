import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

async function exists(path) {
  try { await access(path, fsConstants.F_OK); return true; } catch { return false; }
}

export async function readAcceptanceContract({ goalId, worktreePath }) {
  const path = join(worktreePath, '.gptwork', 'goals', goalId, 'acceptance.contract.json');
  if (!(await exists(path))) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export async function validateAcceptanceContract(contract) {
  if (!contract) return { valid: false, errors: ['contract not found'] };
  const errors = [];
  if (!contract.verdict_required) errors.push('verdict_required is missing');
  if (!Array.isArray(contract.checkpoints)) errors.push('checkpoints must be an array');
  return { valid: errors.length === 0, errors };
}
