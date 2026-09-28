/** Local password rules. The UI shows the same rules; this module is the authority. */
/**
 * Deliberately modest: organisations sign in through OIDC, so local accounts are for small teams
 * and evaluation. The login throttle does the rest.
 */
export const PASSWORD_MIN_LENGTH = 8;
/** An upper bound so a huge body can't make scrypt the bottleneck. */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The handful of passwords every guessing list starts with. Short on purpose; this is not a
 * strength meter.
 */
const BLOCKLIST = new Set([
  'password',
  'password1',
  '12345678',
  '123456789',
  '1234567890',
  '87654321',
  'qwertyui',
  'qwerty123',
  'iloveyou',
  'letmein1',
  'changeme',
  'welcome1',
  'admin123',
  'administrator',
  'switchboard',
]);

/** Why `password` is not acceptable for the account `email`, or null when it is. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  const address = email.trim().toLowerCase();
  const local = address.split('@')[0] ?? '';
  if (lower === address || (local !== '' && lower === local))
    return 'The password cannot be your email address.';
  if (BLOCKLIST.has(lower) || /^(.)\1+$/.test(password))
    return 'That password is too common; choose another.';
  return null;
}
