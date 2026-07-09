'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

type NotifyMode = 'all' | 'new_contact_only';

export function NotificationSettings() {
  const { accountId, accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [notifyMode, setNotifyMode] = useState<NotifyMode>('new_contact_only');
  const [adminPhone, setAdminPhone] = useState('');

  // Same guard pattern as ai-config.tsx / whatsapp-config.tsx: only
  // refetch when the account actually changes, so unrelated auth
  // context churn doesn't clobber an unsaved edit.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/settings/notifications');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to load notification settings');
        return;
      }
      setEnabled(Boolean(data.enabled));
      setNotifyMode((data.notify_mode as NotifyMode) ?? 'new_contact_only');
      setAdminPhone(data.admin_phone ?? '');
    } catch {
      toast.error('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
  }, [accountId, fetchConfig]);

  const handleSave = async () => {
    if (!adminPhone.trim()) {
      toast.error('Enter the phone number that should receive notifications.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/settings/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          notify_mode: notifyMode,
          admin_phone: adminPhone.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success('Notification settings saved.');
        await fetchConfig();
      } else {
        toast.error(data.error ?? 'Failed to save.');
      }
    } catch {
      toast.error('Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="Notifications"
        description="Get a WhatsApp alert on your own phone whenever a customer messages the business number. Sent via the approved paradesk_nuevo_mensaje template — never through the business number itself."
      />

      <Card>
        <CardHeader>
          <CardTitle>WhatsApp alerts</CardTitle>
          <CardDescription>
            Choose when you want to be notified and where.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div>
              <p className="text-sm font-medium text-foreground">
                Notify me on WhatsApp
              </p>
              <p className="text-sm text-muted-foreground">
                Master switch for the alerts below.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEdit}
            />
          </div>

          <div className="space-y-3">
            <Label>When should I be notified?</Label>
            <RadioGroup
              value={notifyMode}
              onValueChange={(value) => setNotifyMode(value as NotifyMode)}
              disabled={!canEdit || !enabled}
            >
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 has-[[data-checked]]:border-primary">
                <RadioGroupItem value="all" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Every new message
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Notify me on every inbound customer message.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3 rounded-lg border border-border p-3 has-[[data-checked]]:border-primary">
                <RadioGroupItem value="new_contact_only" className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    Only new contacts
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    Notify me only the first time a phone number writes in.
                  </span>
                </span>
              </label>
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-phone">Your phone number</Label>
            <Input
              id="admin-phone"
              value={adminPhone}
              onChange={(e) => setAdminPhone(e.target.value)}
              placeholder="+19545405754"
              disabled={!canEdit}
            />
            <p className="text-sm text-muted-foreground">
              E.164 format, with country code. This should be your personal
              number — not the business number connected to this CRM.
            </p>
          </div>

          {canEdit ? (
            <Button onClick={handleSave} disabled={saving}>
              {saving ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
