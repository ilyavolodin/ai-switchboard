/**
 * The server (`auth/password-policy.ts`) is the authority and also rejects the most common
 * passwords; these checks only give feedback while typing.
 */
export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRule {
  label: string;
  met: boolean;
}

export function passwordRules(password: string, email: string): PasswordRule[] {
  const address = email.trim().toLowerCase();
  const local = address.split('@')[0] ?? '';
  const lower = password.toLowerCase();
  return [
    {
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      met: password.length >= PASSWORD_MIN_LENGTH,
    },
    {
      label: 'Not your email address',
      met: password !== '' && lower !== address && lower !== local,
    },
    { label: 'Not a common password (checked when you save)', met: password !== '' },
  ];
}

export function passwordError(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  const rules = passwordRules(password, email);
  if (rules[1] && !rules[1].met) return 'The password cannot be your email address.';
  return null;
}
