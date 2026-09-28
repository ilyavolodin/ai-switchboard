/**
 * The local password rules, as the form shows them. The server (`auth/password-policy.ts`) is the
 * authority and also rejects the most common passwords; these checks give feedback while typing.
 */
export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRule {
  label: string;
  met: boolean;
}

/** Each rule and whether `password` meets it for the account `email`. */
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

/** The first unmet rule as an error message, or null when the password can be sent. */
export function passwordError(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH)
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  const rules = passwordRules(password, email);
  if (rules[1] && !rules[1].met) return 'The password cannot be your email address.';
  return null;
}
