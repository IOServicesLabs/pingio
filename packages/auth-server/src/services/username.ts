import { validateUsername, sanitizeUsername } from '@pingio/shared';

export function suggestUsernames(base: string, count: number = 5): string[] {
  const normalized = sanitizeUsername(base).replace(/[^a-z0-9_-]/g, '');
  const suggestions: string[] = [];

  // Append short random numeric suffixes
  const used = new Set<string>();
  while (suggestions.length < count) {
    const suffix = Math.floor(Math.random() * 9000) + 1000; // 1000-9999
    const candidate = `${normalized}${suffix}`;
    if (!used.has(candidate) && candidate.length <= 32) {
      used.add(candidate);
      suggestions.push(candidate);
    }
  }

  return suggestions;
}

export function isValidUsername(username: string): { valid: boolean; error?: string } {
  return validateUsername(username);
}
