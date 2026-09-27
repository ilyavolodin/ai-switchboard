import type { GlobalSettings } from '@ai-switchboard/core/contract';
import { useState } from 'react';

import { errorMessage } from '../../api/client.js';
import { useSettings, useUpdateSettings } from '../../api/index.js';
import { useCan, useSession } from '../../app/session.js';
import { Banner } from '../../components/Banner.js';
import { Button } from '../../components/Button.js';
import { Card } from '../../components/Card.js';
import { Field } from '../../components/Field.js';
import { Icon } from '../../components/Icon.js';
import { Skeleton } from '../../components/Skeleton.js';
import { StatusChip } from '../../components/StatusChip.js';
import { TextField } from '../../components/TextField.js';
import { useReasonedMutation } from '../../hooks/reason.js';
import styles from './Settings.module.css';
import { parseDomains } from './settingsForm.js';

/**
 * Sign-in: the OIDC issuer, client id and allowed domains. The client secret is a secret
 * reference read from the environment, and sign-in changes take effect after a restart.
 */
export function SignInTab() {
  const settings = useSettings();
  if (settings.isPending) return <Skeleton shape="card" height={260} label="Loading sign-in" />;
  if (settings.isError) {
    return (
      <Banner tone="error" title="Sign-in settings could not load">
        {errorMessage(settings.error)}
      </Banner>
    );
  }
  return <SignInForm key={JSON.stringify(settings.data.oidc)} oidc={settings.data.oidc} />;
}

function SignInForm({ oidc }: { oidc: GlobalSettings['oidc'] }) {
  const session = useSession();
  const isAdmin = useCan('admin');
  const [issuer, setIssuer] = useState(oidc?.issuer ?? '');
  const [clientId, setClientId] = useState(oidc?.clientId ?? '');
  const [domains, setDomains] = useState((oidc?.allowedDomains ?? []).join(', '));

  const next = {
    issuer: issuer.trim(),
    clientId: clientId.trim(),
    allowedDomains: parseDomains(domains),
  };
  const cleared = next.issuer === '' && next.clientId === '';
  const incomplete = !cleared && (next.issuer === '' || next.clientId === '');
  const badIssuer = next.issuer !== '' && !next.issuer.startsWith('https://');
  const dirty = JSON.stringify(cleared ? null : next) !== JSON.stringify(oidc);
  const configured = oidc != null && session.oidcConfigured;

  const save = useReasonedMutation(
    useUpdateSettings(),
    {
      title: 'Save sign-in settings?',
      consequence:
        'The new issuer and client id apply after the next restart; people keep their current sessions until then.',
      confirmLabel: 'Save sign-in',
      danger: true,
    },
    { successMessage: 'Sign-in saved — restart to apply' },
  );

  return (
    <div className={styles.stack}>
      {!configured && (
        <Banner tone="warn" title="OIDC is not configured">
          {session.authMode === 'local'
            ? 'Sign-in uses local passwords (Settings › Users). Set an issuer and client id below (and OIDC_CLIENT_SECRET in the environment), then restart to add single sign-on; local passwords keep working.'
            : 'The issuer is set but the server could not use it. Check the issuer URL and the client secret in the environment, then restart.'}
        </Banner>
      )}
      <Card
        title="Sign-in · OIDC"
        meta={
          <StatusChip
            size="sm"
            tone={configured ? 'ok' : 'warn'}
            label={configured ? 'configured' : 'not configured'}
          />
        }
      >
        <div className={styles.fields}>
          <Field
            label="Issuer"
            layout="row"
            help="Google Workspace, Okta, Entra, Keycloak — any OpenID Connect issuer URL."
            error={badIssuer ? 'The issuer must be an https:// URL' : null}
            changed={next.issuer !== (oidc?.issuer ?? '')}
          >
            {({ id, describedBy, invalid }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                mono
                placeholder="https://accounts.google.com"
                value={issuer}
                disabled={!isAdmin}
                onChange={(e) => {
                  setIssuer(e.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label="Client id"
            layout="row"
            error={
              incomplete && next.clientId === '' ? 'A client id is required with an issuer' : null
            }
            changed={next.clientId !== (oidc?.clientId ?? '')}
          >
            {({ id, describedBy, invalid }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                invalid={invalid}
                mono
                value={clientId}
                disabled={!isAdmin}
                onChange={(e) => {
                  setClientId(e.target.value);
                }}
              />
            )}
          </Field>
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
          <Field
            label="Allowed domains"
            layout="row"
            help="Comma-separated. Emails outside these domains, or without a user row, land on an “ask an admin” page."
            changed={
              JSON.stringify(next.allowedDomains) !== JSON.stringify(oidc?.allowedDomains ?? [])
            }
          >
            {({ id, describedBy }) => (
              <TextField
                id={id}
                aria-describedby={describedBy}
                mono
                placeholder="lola.com"
                value={domains}
                disabled={!isAdmin}
                onChange={(e) => {
                  setDomains(e.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <p className={styles.hint}>
          Sign-in changes apply after a restart. Sessions are 12-hour sliding cookies; revoke a
          person’s sessions from Users.
        </p>
        <div className={styles.footer}>
          <Button
            variant="primary"
            requires="admin"
            disabled={!dirty || incomplete || badIssuer}
            disabledReason={dirty ? 'Fix the highlighted fields first' : 'Nothing changed'}
            loading={save.pending}
            onClick={() => void save.run({ settings: { oidc: cleared ? null : next } })}
          >
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}
