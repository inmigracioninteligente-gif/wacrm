'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, Copy, KeyRound, Loader2, XCircle } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface TwilioConfigState {
  configured: boolean;
  account_sid: string | null;
  from_number: string | null;
  status: 'connected' | 'disconnected' | null;
  ingest_url: string;
  migration_missing?: boolean;
  error?: string;
}

/**
 * Settings card for running the inbox on a Twilio WhatsApp number whose
 * inbound webhook is owned by another app (which relays events here).
 */
export function TwilioConfig() {
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [state, setState] = useState<TwilioConfigState | null>(null);
  const [accountSid, setAccountSid] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [fromNumber, setFromNumber] = useState('');
  // Shown once after first save / rotation; never refetchable.
  const [relaySecret, setRelaySecret] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/channels/twilio/config');
      const data = (await res.json()) as TwilioConfigState;
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load Twilio settings');
        return;
      }
      setState(data);
      setAccountSid(data.account_sid ?? '');
      setFromNumber(data.from_number ?? '');
      setAuthToken('');
    } catch {
      toast.error('Failed to load Twilio settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void load();
  }, [accountId, load]);

  const post = async (body: Record<string, unknown>) => {
    setSaving(true);
    try {
      const res = await fetch('/api/channels/twilio/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to save');
        return;
      }
      if (data.relay_secret) setRelaySecret(data.relay_secret);
      toast.success(body.action === 'rotate_secret' ? 'New relay secret issued' : 'Twilio settings saved');
      await load();
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () =>
    post({ account_sid: accountSid.trim(), auth_token: authToken.trim(), from_number: fromNumber.trim() });

  const handleRotate = () => {
    if (
      !window.confirm(
        'Issue a new relay secret? The old one stops working immediately — update it in the relaying app right away.',
      )
    )
      return;
    void post({ action: 'rotate_secret' });
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect the Twilio number from this workspace?')) return;
    setSaving(true);
    try {
      const res = await fetch('/api/channels/twilio/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to disconnect');
        return;
      }
      setRelaySecret(null);
      toast.success('Twilio number disconnected');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (state?.migration_missing) {
    return (
      <Alert>
        <AlertTitle>Twilio channel not installed</AlertTitle>
        <AlertDescription>
          Run <code>supabase/migrations/036_twilio_channel.sql</code> in the Supabase SQL
          Editor, then reload this page.
        </AlertDescription>
      </Alert>
    );
  }

  const connected = state?.configured && state.status === 'connected';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Twilio number (relayed)</CardTitle>
        <CardDescription className="text-muted-foreground">
          Use a WhatsApp number that lives in Twilio. The app that owns the number keeps its
          webhook and forwards a copy of each message here; replies from the inbox go out
          through Twilio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-2 text-sm">
          {connected ? (
            <>
              <CheckCircle2 className="size-4 text-green-500" />
              <span className="text-foreground">
                Connected — {state?.from_number}
              </span>
            </>
          ) : (
            <>
              <XCircle className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">Not connected</span>
            </>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="twilio-sid">Account SID</Label>
          <Input
            id="twilio-sid"
            autoComplete="off"
            placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            value={accountSid}
            onChange={(e) => setAccountSid(e.target.value)}
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="twilio-token">Auth Token</Label>
          <Input
            id="twilio-token"
            type="password"
            autoComplete="new-password"
            placeholder={state?.configured ? 'Saved — leave blank to keep it' : 'Twilio Auth Token'}
            value={authToken}
            onChange={(e) => setAuthToken(e.target.value)}
            disabled={!canEdit}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="twilio-from">WhatsApp number</Label>
          <Input
            id="twilio-from"
            autoComplete="off"
            placeholder="+17863860961"
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            disabled={!canEdit}
          />
        </div>

        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {state?.configured ? 'Update' : 'Save & connect'}
            </Button>
            {state?.configured && (
              <>
                <Button variant="outline" onClick={handleRotate} disabled={saving}>
                  <KeyRound className="mr-2 size-4" />
                  New relay secret
                </Button>
                <Button variant="outline" onClick={handleDisconnect} disabled={saving}>
                  Disconnect
                </Button>
              </>
            )}
          </div>
        )}

        {state?.configured && (
          <div className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm font-medium text-foreground">Relay settings for the other app</p>
            <div className="space-y-1">
              <Label>Relay URL</Label>
              <div className="flex gap-2">
                <Input readOnly value={state.ingest_url} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => copy(state.ingest_url, 'Relay URL')}
                  aria-label="Copy relay URL"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
            {relaySecret ? (
              <Alert>
                <AlertTitle>Relay secret — copy it now</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>
                    It is shown only once. Store it in the relaying app as a secret and send it as{' '}
                    <code>Authorization: Bearer …</code>.
                  </p>
                  <div className="flex gap-2">
                    <Input readOnly value={relaySecret} className="font-mono text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => copy(relaySecret, 'Relay secret')}
                      aria-label="Copy relay secret"
                    >
                      <Copy className="size-4" />
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">
                The relay secret was shown when it was created. Lost it? Issue a new one.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
