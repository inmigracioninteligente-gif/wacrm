'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  ListTree,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

interface AgentProfile {
  id: string;
  name: string;
  menu_label: string;
  extra_keywords: string | null;
  position: number;
  system_prompt: string;
  is_active: boolean;
  handoff_tag: string | null;
  handoff_pipeline_stage: string | null;
}

/** Editor target: 'new' when creating, a profile id when editing, null when closed. */
type EditTarget = 'new' | string | null;

const emptyForm = {
  name: '',
  menu_label: '',
  extra_keywords: '',
  system_prompt: '',
  is_active: true,
  handoff_tag: '',
  handoff_pipeline_stage: '',
};

export function AiAgentProfilesCard({
  accountId,
  canEdit,
}: {
  accountId: string | null;
  canEdit: boolean;
}) {
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [reordering, setReordering] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agent-profiles');
      const data = await res.json();
      if (res.ok) setProfiles(data.profiles ?? []);
      else toast.error(data.error ?? 'Failed to load agent profiles');
    } catch {
      toast.error('Failed to load agent profiles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchProfiles();
  }, [accountId, fetchProfiles]);

  const openNew = () => {
    setEditing('new');
    setForm(emptyForm);
  };

  const openEdit = (profile: AgentProfile) => {
    setEditing(profile.id);
    setForm({
      name: profile.name,
      menu_label: profile.menu_label,
      extra_keywords: profile.extra_keywords ?? '',
      system_prompt: profile.system_prompt,
      is_active: profile.is_active,
      handoff_tag: profile.handoff_tag ?? '',
      handoff_pipeline_stage: profile.handoff_pipeline_stage ?? '',
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm);
  };

  const save = async () => {
    if (!form.name.trim() || !form.menu_label.trim() || !form.system_prompt.trim()) {
      toast.error('Nombre, texto del menú y system prompt son obligatorios.');
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/agent-profiles' : `/api/ai/agent-profiles/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            menu_label: form.menu_label.trim(),
            extra_keywords: form.extra_keywords.trim() || null,
            system_prompt: form.system_prompt.trim(),
            is_active: form.is_active,
            handoff_tag: form.handoff_tag.trim() || null,
            handoff_pipeline_stage: form.handoff_pipeline_stage.trim() || null,
          }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        toast.success(isNew ? 'Perfil creado.' : 'Perfil actualizado.');
        cancelEdit();
        await fetchProfiles();
      } else {
        toast.error(data.error ?? 'No se pudo guardar.');
      }
    } catch {
      toast.error('No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/agent-profiles/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Perfil eliminado.');
        setProfiles((p) => p.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'No se pudo eliminar.');
      }
    } catch {
      toast.error('No se pudo eliminar.');
    }
  };

  const toggleActive = async (profile: AgentProfile) => {
    const next = !profile.is_active;
    setProfiles((p) =>
      p.map((x) => (x.id === profile.id ? { ...x, is_active: next } : x)),
    );
    try {
      const res = await fetch(`/api/ai/agent-profiles/${profile.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: next }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? 'No se pudo actualizar.');
        await fetchProfiles();
      }
    } catch {
      toast.error('No se pudo actualizar.');
      await fetchProfiles();
    }
  };

  const move = async (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= profiles.length) return;

    const a = profiles[index];
    const b = profiles[targetIndex];
    setReordering(a.id);

    // Optimistic swap in the list ordering.
    const next = [...profiles];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    setProfiles(next);

    try {
      const [resA, resB] = await Promise.all([
        fetch(`/api/ai/agent-profiles/${a.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: b.position }),
        }),
        fetch(`/api/ai/agent-profiles/${b.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ position: a.position }),
        }),
      ]);
      if (!resA.ok || !resB.ok) {
        toast.error('No se pudo reordenar.');
        await fetchProfiles();
      }
    } catch {
      toast.error('No se pudo reordenar.');
      await fetchProfiles();
    } finally {
      setReordering(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTree className="h-4 w-4 text-primary" /> Perfiles
        </CardTitle>
        <CardDescription>
          Cada conversación nueva elige uno de estos perfiles por menú antes
          de hablar con la IA. Solo los perfiles activos aparecen en el menú,
          en este orden.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : (
          <>
            {profiles.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">
                Todavía no hay perfiles. Sin perfiles activos, el menú se
                omite y se usa el comportamiento de agente único.
              </p>
            )}

            {profiles.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {profiles.map((profile, index) => (
                  <li
                    key={profile.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      {canEdit && (
                        <div className="flex shrink-0 flex-col">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-4 w-6 p-0"
                            onClick={() => void move(index, 'up')}
                            disabled={index === 0 || reordering !== null}
                            title="Subir"
                          >
                            <ChevronUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-4 w-6 p-0"
                            onClick={() => void move(index, 'down')}
                            disabled={index === profiles.length - 1 || reordering !== null}
                            title="Bajar"
                          >
                            <ChevronDown className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {profile.name}
                          </span>
                          <Badge variant={profile.is_active ? 'default' : 'outline'}>
                            {profile.is_active ? 'Activo' : 'Inactivo'}
                          </Badge>
                        </div>
                        <span className="block truncate text-xs text-muted-foreground">
                          {profile.menu_label}
                        </span>
                      </div>
                    </div>
                    {canEdit && (
                      <span className="flex shrink-0 items-center gap-1">
                        <Switch
                          checked={profile.is_active}
                          onCheckedChange={() => void toggleActive(profile)}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => openEdit(profile)}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(profile.id)}
                          title="Eliminar"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="profile-name">Nombre interno</Label>
                    <Input
                      id="profile-name"
                      value={form.name}
                      onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                      placeholder="ej. Certificación AMI"
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-menu-label">Texto del menú</Label>
                    <Input
                      id="profile-menu-label"
                      value={form.menu_label}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, menu_label: e.target.value }))
                      }
                      placeholder="ej. Certificación AMI"
                      disabled={saving}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="profile-keywords">
                    Palabras clave adicionales{' '}
                    <span className="font-normal text-muted-foreground">
                      (opcional, separadas por coma)
                    </span>
                  </Label>
                  <Input
                    id="profile-keywords"
                    value={form.extra_keywords}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, extra_keywords: e.target.value }))
                    }
                    placeholder="ej. curso, capacitación"
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">
                    Además de las palabras del texto del menú, estas también
                    hacen match cuando el cliente responde al menú.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="profile-prompt">System prompt</Label>
                  <Textarea
                    id="profile-prompt"
                    value={form.system_prompt}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, system_prompt: e.target.value }))
                    }
                    placeholder="Instrucciones completas para este perfil…"
                    rows={10}
                    disabled={saving}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="profile-handoff-tag">
                      Etiqueta al completar objetivo{' '}
                      <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      id="profile-handoff-tag"
                      value={form.handoff_tag}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, handoff_tag: e.target.value }))
                      }
                      placeholder="ej. AMI - Lead"
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="profile-handoff-stage">
                      Etapa de Pipeline al completar objetivo{' '}
                      <span className="font-normal text-muted-foreground">(opcional)</span>
                    </Label>
                    <Input
                      id="profile-handoff-stage"
                      value={form.handoff_pipeline_stage}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, handoff_pipeline_stage: e.target.value }))
                      }
                      placeholder="ej. Qualified"
                      disabled={saving}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Cuando la IA le dice al cliente que alguien del equipo lo va a
                  contactar (el mensaje de cierre de este perfil), el contacto se
                  etiqueta y/o se mueve a esta etapa automáticamente y la IA se
                  desactiva en esa conversación. Debe coincidir exactamente con el
                  nombre de una etapa que ya exista en tu Pipeline. Deja vacío
                  cualquiera de los dos para no hacer esa acción.
                </p>
                <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Activo</p>
                    <p className="text-xs text-muted-foreground">
                      Solo los perfiles activos aparecen en el menú.
                    </p>
                  </div>
                  <Switch
                    checked={form.is_active}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, is_active: v }))}
                    disabled={saving}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    Cancelar
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Guardar perfil
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <Button variant="outline" size="sm" onClick={openNew}>
                  <Plus className="mr-2 h-4 w-4" /> Agregar perfil
                </Button>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
