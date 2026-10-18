<script lang="ts">
  import { untrack } from 'svelte';
  import { FIXED_LABEL_TYPES, type ProfileFieldType } from '@folio/db';
  import { t } from '#lib/i18n/index.ts';
  import { app, dep, services, track, wizards } from '#lib/state.svelte.ts';
  import Icon from './Icon.svelte';
  import { tip } from './tip.ts';

  const m = wizards.profiles();
  const v = $derived(track());
  const profiles = $derived(dep(v, m.profiles));
  const templates = $derived(dep(v, m.templates));
  const current = $derived(dep(v, m.current));
  const TYPES: ProfileFieldType[] = ['text', 'date', 'number', 'phone', 'email', 'address', 'choice', 'multiline'];
  const fixedLabel = (ty: ProfileFieldType): boolean => FIXED_LABEL_TYPES.includes(ty);
  let newName = $state('');
  let startWith = $state<string[]>(['builtin:identity', 'builtin:address', 'builtin:contacts']);
  let addLabel = $state('');
  let addType = $state<ProfileFieldType>('text');
  let templateToAdd = $state('');
  let asTemplate = $state('');
  let newTemplate = $state('');
  let keyEdit = $state<{ key: string; value: string } | null>(null);
  let editingTemplate = $state<string | null>(null);
  const templateBeingEdited = $derived(templates.find((x) => x.id === editingTemplate) ?? null);
  const nameOf = (id: string, name: string, builtIn: boolean): string => (builtIn ? t(`settings.profile.template.${name}`) : name);

  $effect(() => {
    untrack(() => void m.load());
  });
  async function create(): Promise<void> {
    if (!newName.trim()) return;
    if (await m.create(newName, startWith)) newName = '';
  }
  async function addField(): Promise<void> {
    if (!current || (!fixedLabel(addType) && !addLabel.trim())) return;
    await m.addField(current.id, addLabel, addType);
    addLabel = '';
  }
  async function exportProfile(): Promise<void> {
    if (!current) return;
    const ref = await services.platform.files.pickSave({ suggestedName: `${current.name}.profile.json`, kind: 'json' });
    if (ref) await services.platform.files.write(ref, new TextEncoder().encode(JSON.stringify(await services.profiles.exportJson(current.id), null, 2)), { atomic: true });
  }
  async function importProfile(): Promise<void> {
    const [ref] = await services.platform.files.pickOpen({ accept: ['json'] });
    if (!ref) return;
    let data: unknown = null;
    try {
      data = JSON.parse(new TextDecoder().decode(await services.platform.files.read(ref)));
    } catch {
      /* reported as "not a profile file" */
    }
    await app.guard(() => services.profiles.importJson(data));
    await m.load();
  }
  const aliasesOf = (text: string): string[] => text.split(',').map((a) => a.trim()).filter(Boolean);
</script>

{#if current}
  {@const p = current}
  <div class="row pheader"><button class="btn sm ghost" style="flex:none" onclick={() => m.open(null)} aria-label={t('action.back')}><Icon name="chevron-left" /></button>
    <input type="text" value={p.name} aria-label={t('settings.profile.name')} maxlength="60" onchange={async (e) => { const input = e.currentTarget; if (!(await m.rename(p.id, input.value))) input.value = p.name; }} />
    {#if !p.isDefault}<button class="btn sm" style="flex:none" onclick={() => m.setDefault(p.id)}>{t('action.setDefault')}</button>{/if}
    <button class="btn sm" style="flex:none" onclick={() => m.duplicate(p.id)}>{t('profiles.duplicate')}</button>
  </div>
  <div class="row psign">
    <label for="psig">{t('profiles.signature')}</label>
    <select id="psig" value={p.signatureId ?? ''} onchange={(e) => m.setSignature(p.id, e.currentTarget.value || null)}>
      <option value="">{t('profiles.signatureNone')}</option>
      {#each m.signatures as sg (sg.id)}<option value={sg.id}>{sg.name}</option>{/each}
    </select>
  </div>
  {#if m.signatures.length === 0}<p class="note">{t('profiles.signatureHint')}</p>{/if}
  <div class="pfields">
    {#each p.fields as f, i (f.key)}
      <div class="pfield">
        <div class="pmain">
          {#if fixedLabel(f.type)}
            <span class="plabel">{t(`profiles.type.${f.type}`)}</span>
          {:else}
            <input type="text" value={f.label} placeholder={t('settings.profile.label')} aria-label={t('profiles.labelOf', { label: f.label })} onchange={(e) => m.updateField(p.id, f.key, { label: e.currentTarget.value })} />
          {/if}
          <input id="pf-{f.key}" placeholder={t('settings.profile.value')} aria-label={f.label} type={f.sensitive ? 'password' : f.type === 'date' ? 'date' : f.type === 'email' ? 'email' : 'text'} value={f.value} autocomplete="off" onchange={(e) => m.updateField(p.id, f.key, { value: e.currentTarget.value })} />
        </div>
        <div class="pbar">
          <select value={f.type} aria-label={t('profiles.typeOf', { label: f.label })} onchange={(e) => m.updateField(p.id, f.key, { type: e.currentTarget.value as ProfileFieldType })}>
            {#each TYPES as ty (ty)}<option value={ty}>{t(`profiles.type.${ty}`)}</option>{/each}
          </select>
          <label class="psens" title={t('settings.profile.sensitiveHint')}><input type="checkbox" aria-label="{t('settings.profile.sensitive')}: {f.label}" checked={f.sensitive} onchange={(e) => m.updateField(p.id, f.key, { sensitive: e.currentTarget.checked })} />{t('settings.profile.sensitive')}</label>
          <span class="grow"></span>
          <button class="ib" disabled={i === 0} onclick={() => m.moveField(p.id, f.key, -1)} aria-label={t('profiles.up', { label: f.label })}><Icon name="arrow-up" /></button>
          <button class="ib" disabled={i === p.fields.length - 1} onclick={() => m.moveField(p.id, f.key, 1)} aria-label={t('profiles.down', { label: f.label })}><Icon name="arrow-down" /></button>
          <button class="ib" onclick={() => m.removeField(p.id, f.key)} aria-label="{t('action.remove')} {f.label}"><Icon name="x" /></button>
        </div>
        <div class="pmeta note">
          <span class="pkey">{t('settings.profile.key')}: <code>{f.key}</code>
            {#if keyEdit?.key === f.key}
              <input type="text" aria-label={t('profiles.newKey')} bind:value={keyEdit.value} style="width:140px" />
              <button class="link" onclick={async () => { const next = keyEdit!.value; keyEdit = null; if (next && next !== f.key) await m.changeKey(p.id, f.key, next); }}>{t('action.apply')}</button>
              <button class="link" onclick={() => (keyEdit = null)}>{t('action.cancel')}</button>
            {:else}
              <button class="link" onclick={() => (keyEdit = { key: f.key, value: f.key })}>{t('profiles.changeKey')}</button>
            {/if}</span>
          <span class="pnames"><label for="al-{f.key}">{t('profiles.aliases')}</label><input id="al-{f.key}" type="text" value={f.aliases.join(', ')} onchange={(e) => m.updateField(p.id, f.key, { aliases: aliasesOf(e.currentTarget.value) })} /></span>
          {#if f.type === 'choice'}
            <span class="pnames"><label for="op-{f.key}">{t('profiles.options')}</label><input id="op-{f.key}" type="text" value={f.options.join(', ')} onchange={(e) => m.updateField(p.id, f.key, { options: aliasesOf(e.currentTarget.value) })} /></span>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  <div class="row">
    <select bind:value={addType} aria-label={t('profiles.type')} style="flex:none;width:auto">{#each TYPES as ty (ty)}<option value={ty}>{t(`profiles.type.${ty}`)}</option>{/each}</select>
    {#if !fixedLabel(addType)}<input type="text" bind:value={addLabel} placeholder={t('settings.profile.label')} aria-label={t('profiles.newField')} style="flex:1" />{:else}<span class="grow"></span>{/if}
    <button class="btn" style="flex:none" disabled={!fixedLabel(addType) && !addLabel.trim()} onclick={addField}><Icon name="plus" />{t('settings.profile.addEntry')}</button>
  </div>
  <p class="note">{t('settings.profile.sensitiveHint')}</p>
  <div class="row">
    <select bind:value={templateToAdd} aria-label={t('profiles.addTemplate')} style="flex:1">
      <option value="">{t('profiles.addTemplate')}</option>
      {#each templates as tpl (tpl.id)}<option value={tpl.id}>{nameOf(tpl.id, tpl.name, tpl.builtIn)}</option>{/each}
    </select>
    <button class="btn" style="flex:none" disabled={!templateToAdd} onclick={async () => (await m.addTemplate(p.id, templateToAdd), (templateToAdd = ''))}>{t('action.add')}</button>
  </div>
  {#if m.skipped.length}<p class="note" role="status">{t('profiles.skipped', { count: m.skipped.length, keys: m.skipped.join(', ') })}</p>{/if}
  <div class="row">
    <input type="text" bind:value={asTemplate} placeholder={t('profiles.templateName')} aria-label={t('profiles.templateName')} style="flex:1" />
    <button class="btn" style="flex:none" disabled={!asTemplate.trim()} onclick={async () => (await m.saveAsTemplate(p.id, asTemplate), (asTemplate = ''))}>{t('profiles.saveAsTemplate')}</button>
  </div>
  <div class="row"><button class="btn sm" onclick={exportProfile}>{t('settings.profile.export')}</button><span class="grow"></span><button class="btn sm danger" onclick={async () => (await m.remove(p.id)) && m.open(null)}><Icon name="trash-2" />{t('action.delete')}</button></div>
{:else if templateBeingEdited}
  {@const tpl = templateBeingEdited}
  <div class="row"><button class="btn sm ghost" style="flex:none" onclick={() => (editingTemplate = null)} aria-label={t('action.back')}><Icon name="chevron-left" /></button>
    <input type="text" value={tpl.name} aria-label={t('profiles.templateName')} disabled={tpl.builtIn} maxlength="60" onchange={(e) => m.updateTemplate(tpl.id, { name: e.currentTarget.value })} />
  </div>
  {#if tpl.builtIn}<p class="note">{t('profiles.builtIn')}</p>{/if}
  <div class="ptable">
    <b class="lab">{t('settings.profile.label')}</b><b class="lab">{t('profiles.aliases')}</b><b class="lab">{t('profiles.type')}</b><span></span>
    {#each tpl.fields as f (f.key)}
      <input type="text" value={f.label} disabled={tpl.builtIn} aria-label={t('profiles.labelOf', { label: f.label })} onchange={(e) => m.updateTemplate(tpl.id, { fields: tpl.fields.map((x) => (x.key === f.key ? { ...x, label: e.currentTarget.value } : x)) })} />
      <input type="text" value={f.aliases.join(', ')} disabled={tpl.builtIn} aria-label={t('profiles.aliases')} onchange={(e) => m.updateTemplate(tpl.id, { fields: tpl.fields.map((x) => (x.key === f.key ? { ...x, aliases: aliasesOf(e.currentTarget.value) } : x)) })} />
      <select value={f.type} disabled={tpl.builtIn} aria-label={t('profiles.typeOf', { label: f.label })} onchange={(e) => m.updateTemplate(tpl.id, { fields: tpl.fields.map((x) => (x.key === f.key ? { ...x, type: e.currentTarget.value as ProfileFieldType } : x)) })}>{#each TYPES as ty (ty)}<option value={ty}>{t(`profiles.type.${ty}`)}</option>{/each}</select>
      <button class="ib" disabled={tpl.builtIn} onclick={() => m.updateTemplate(tpl.id, { fields: tpl.fields.filter((x) => x.key !== f.key) })} aria-label="{t('action.remove')} {f.label}"><Icon name="x" /></button>
    {/each}
  </div>
  {#if !tpl.builtIn}
    <div class="row">
      <input type="text" bind:value={addLabel} placeholder={t('settings.profile.label')} aria-label={t('profiles.newField')} style="flex:1" />
      <button class="btn" style="flex:none" disabled={!addLabel.trim()} onclick={async () => {
          await m.updateTemplate(tpl.id, { fields: [...tpl.fields, { key: addLabel, label: addLabel.trim(), type: 'text', aliases: [], sensitive: false, options: [] }] });
          addLabel = '';
        }}><Icon name="plus" />{t('settings.profile.addEntry')}</button>
    </div>
  {/if}
{:else}
  {#if profiles.length === 0}<p class="note">{t('settings.profile.empty')}</p>{/if}
  <ul class="rlist">
    {#each profiles as p (p.id)}
      <li><Icon name="user" /><b>{p.name}</b>{#if p.isDefault}<span class="chip acc">{t('action.default')}</span>{/if}<small>{t('settings.profile.entries', { count: p.fields.filter((f) => f.value).length })}</small><button class="btn sm" onclick={() => m.open(p.id)}>{t('action.edit')}</button></li>
    {/each}
  </ul>
  <div class="field"><label for="pn">{t('settings.profile.new')}</label>
    <div class="row"><input id="pn" type="text" maxlength="60" bind:value={newName} placeholder={t('settings.profile.name')} style="flex:1" /><button class="btn" style="flex:none" disabled={!newName.trim()} onclick={create}><Icon name="plus" />{t('action.add')}</button><button class="btn" style="flex:none" onclick={importProfile}>{t('settings.profile.import')}</button></div>
    <div class="row" style="flex-wrap:wrap;gap:10px">
      <span class="note" style="flex:none">{t('settings.profile.templates')}</span>
      {#each templates as tpl (tpl.id)}<label style="width:auto;display:flex;gap:4px;align-items:center;flex:none"><input type="checkbox" bind:group={startWith} value={tpl.id} />{nameOf(tpl.id, tpl.name, tpl.builtIn)}</label>{/each}
    </div>
  </div>
  <p class="note">{t('settings.profile.hint')}</p>
  <h3 style="margin:12px 0 4px;font-size:13px">{t('profiles.templatesTitle')}</h3>
  <ul class="rlist">
    {#each templates as tpl (tpl.id)}
      <li><Icon name="list-tree" /><b>{nameOf(tpl.id, tpl.name, tpl.builtIn)}</b>{#if tpl.builtIn}<span class="chip">{t('profiles.builtInChip')}</span>{/if}<small>{t('settings.profile.entries', { count: tpl.fields.length })}</small>
        <button class="btn sm" onclick={() => (editingTemplate = tpl.id)}>{tpl.builtIn ? t('profiles.view') : t('action.edit')}</button>
        <button class="btn sm" onclick={() => m.duplicateTemplate(tpl.id)}>{t('profiles.duplicate')}</button>
        <button class="btn sm" onclick={() => m.exportTemplate(tpl.id)}>{t('settings.profile.export')}</button>
        {#if !tpl.builtIn}<button class="ib" onclick={() => m.removeTemplate(tpl.id)} aria-label="{t('action.delete')} {tpl.name}" use:tip={t('action.delete')}><Icon name="trash-2" /></button>{/if}
      </li>
    {/each}
  </ul>
  <div class="row">
    <input type="text" bind:value={newTemplate} placeholder={t('profiles.templateName')} aria-label={t('profiles.newTemplate')} style="flex:1" />
    <button class="btn" style="flex:none" disabled={!newTemplate.trim()} onclick={async () => { const x = await m.createTemplate(newTemplate); newTemplate = ''; if (x) editingTemplate = x.id; }}><Icon name="plus" />{t('profiles.newTemplate')}</button>
    <button class="btn" style="flex:none" onclick={() => m.importTemplate()}>{t('profiles.importTemplate')}</button>
  </div>
{/if}
