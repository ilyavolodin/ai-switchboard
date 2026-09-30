import type { GlobalSettings } from '@ai-switchboard/core/contract';

import { useSettings } from '../../api/index.js';
import { useCan, useSession } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { QueryBoundary } from '../../components/QueryBoundary.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import styles from './Settings.module.css';
import { SettingsFormCard } from './SettingsFormCard.js';
import { checkSignIn, parseDomains, signInForm } from './settingsForm.js';
import { TextRow } from '../../components/TextRow.js';
import { useSettingsSection } from './useSettingsSection.js';

export function SignInTab() {
  const settings = useSettings();
  return (
    <QueryBoundary
      query={settings}
      errorTitle="Sign-in settings could not load"
      pending={<Skeleton shape="card" height={260} label="Loading sign-in" />}
    >
      {(s) => <SignInForm oidc={s.oidc} />}
    </QueryBoundary>
  );
}

function SignInForm({ oidc }: { oidc: GlobalSettings['oidc'] }) {
  const session = useSession();
  const isAdmin = useCan('admin');
  const section = useSettingsSection({
    form: signInForm(oidc),
    check: (form) => checkSignIn(oidc, form),
    prompt: {
      title: 'Save sign-in settings?',
      consequence:
        'The new issuer and client id apply after the next restart; people keep their current sessions until then.',
      confirmLabel: 'Save sign-in',
      danger: true,
    },
    successMessage: 'Sign-in saved — restart to apply',
  });
  const { draft, errors, set } = section;
  const configured = oidc != null && session.oidcConfigured;

  return (
    <div className={styles.stack}>
      {!configured && (
        <Banner tone="warn" title="OIDC is not configured">
          {session.authMode === 'local'
            ? 'Sign-in uses local passwords (Settings › Users). Set an issuer and client id below (and OIDC_CLIENT_SECRET in the environment), then restart to add single sign-on; local passwords keep working.'
            : 'The issuer is set but the server could not use it. Check the issuer URL and the client secret in the environment, then restart.'}
        </Banner>
      )}
      <SettingsFormCard
        title="Sign-in · OIDC"
        meta={
          <StatusChip
            size="sm"
            tone={configured ? 'ok' : 'warn'}
            label={configured ? 'configured' : 'not configured'}
          />
        }
        section={section}
        unsavedSummary="Unsaved sign-in settings"
        hint="Sign-in changes apply after a restart. Sessions are 12-hour sliding cookies; revoke a person’s sessions from Users."
      >
        <TextRow
          label="Issuer"
          help="Google Workspace, Okta, Entra, Keycloak — any OpenID Connect issuer URL."
          error={errors.issuer}
          changed={draft.issuer.trim() !== (oidc?.issuer ?? '')}
          mono
          placeholder="https://accounts.google.com"
          value={draft.issuer}
          disabled={!isAdmin}
          onChange={(issuer) => {
            set({ issuer });
          }}
        />
        <TextRow
          label="Client id"
          error={errors.clientId}
          changed={draft.clientId.trim() !== (oidc?.clientId ?? '')}
          mono
          value={draft.clientId}
          disabled={!isAdmin}
          onChange={(clientId) => {
            set({ clientId });
          }}
        />
        <Field
          label="Client secret"
          layout="row"
          help="Read from the environment when the server starts; never stored or shown here."
        >
          {() => (
            <span className={styles.secretRef}>
              <Icon name="lock" size={12} />
              OIDC_CLIENT_SECRET
            </span>
          )}
        </Field>
        <TextRow
          label="Allowed domains"
          help="Comma-separated. Emails outside these domains, or without a user row, land on an “ask an admin” page."
          changed={
            JSON.stringify(parseDomains(draft.domains)) !==
            JSON.stringify(oidc?.allowedDomains ?? [])
          }
          mono
          placeholder="lola.com"
          value={draft.domains}
          disabled={!isAdmin}
          onChange={(domains) => {
            set({ domains });
          }}
        />
      </SettingsFormCard>
    </div>
  );
}
