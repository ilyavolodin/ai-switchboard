import { CodeBlock } from '../../components/CodeBlock.js';
import styles from './Login.module.css';

export interface ForgotAccessProps {
  id: string;
  /** Evaluation installs only: the bootstrap local admin's email (`MeResponse`). */
  evaluationAdminEmail: string | null;
}

/**
 * How to get back in without email delivery: an admin resets the password in Settings › Users,
 * or whoever runs the server resets it with the CLI. Names no email except the evaluation
 * admin's, which the server sends only in evaluation mode.
 */
export function ForgotAccess({ id, evaluationAdminEmail }: ForgotAccessProps) {
  return (
    <section id={id} className={styles.forgotPanel} aria-label="Forgot password or email">
      {evaluationAdminEmail && (
        <p className={styles.hint}>
          Evaluation admin: <span className={styles.mono}>{evaluationAdminEmail}</span>
        </p>
      )}
      <p>
        <strong>Ask an admin</strong> to reset your password in Settings › Users. You sign in with
        the temporary password they give you and choose a new one.
      </p>
      <p>
        <strong>If you run the server</strong>, reset it there (this needs no sign-in):
      </p>
      <CodeBlock value="switchboard users reset-password <email>" copyable />
      <p>With Docker Compose:</p>
      <CodeBlock
        value="docker compose exec switchboard switchboard users reset-password <email>"
        copyable
      />
      <p>Forgot the email? List every account:</p>
      <CodeBlock value="switchboard users list" copyable />
    </section>
  );
}
