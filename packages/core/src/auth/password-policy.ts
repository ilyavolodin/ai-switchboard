/** Local password rules. The UI shows the same rules; this module is the authority. */
export const PASSWORD_MIN_LENGTH = 12;
/** An upper bound so a huge body can't make scrypt the bottleneck. */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * The obvious choices people reach for first. Short on purpose: length does most of the work, this
 * only catches the passwords every guessing list starts with.
 */
const BLOCKLIST = new Set([
  '123456789012',
  '1234567890123',
  'qwertyuiopas',
  'qwertyuiop123',
  'password1234',
  'password12345',
  'password123!',
  'passwordpassword',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'administrator',
  'adminadmin123',
  'iloveyou1234',
  'switchboard1',
  'switchboard123',
  'aiswitchboard',
  'correcthorsebatterystaple',
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
