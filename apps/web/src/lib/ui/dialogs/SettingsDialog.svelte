<script lang="ts">
  import { untrack } from 'svelte';
  import { OPENAI_KEY_SECRET } from '@folio/ai';
  import { deleteAllData, PROFILE_TEMPLATES, type Profile, type ProfileFieldType } from '@folio/db';
  import { DATE_FORMATS, formatDate } from '@folio/core';
  import { t } from '#lib/i18n/index.ts';
  import { AI_PROVIDERS } from '@folio/core';
  import { dep, app, desktop, services, track, ui, VERSION, wizards } from '#lib/state.svelte.ts';
  import { tm } from '#lib/i18n/index.ts';
  import Dialog from '../Dialog.svelte';
  import Icon from '../Icon.svelte';

  let { initial = 'appearance' }: { initial?: string } = $props();
  const PANES = ['appearance', 'smartFill', 'profiles', 'general', 'privacy', 'about'] as const;
  // svelte-ignore state_referenced_locally
  let pane = $state<(typeof PANES)[number]>(initial === 'profiles' ? 'profiles' : initial === 'privacy' ? 'privacy' : initial === 'about' ? 'about' : 'appearance');
  const v = $derived(track());
  const s = $derived(dep(v, app.settings));
  const set = app.setSetting.bind(app);
  const ACCENTS = ['#2563eb', '#7c3aed', '#0d9488', '#d97706', '#db2777'];

  // ---- Smart Fill -----------------------------------------------------------------------------
  let keyInput = $state('');
  let hasKey = $state(false);
  const aim = wizards.aiSettings();
  let urlProblem = $state<string | null>(null);
  let baseUrl = $state('');
  let passphrase = $state('');
  const secrets = services.platform.secrets;
  const webSecrets = secrets as unknown as { locked?: boolean; unlock?(p: string): Promise<boolean>; forgetDevice?(): void };
  let secretKind = $state(secrets.kind);
  async function refreshKey(): Promise<void> {
    hasKey = (await secrets.get(OPENAI_KEY_SECRET)) !== null;
    secretKind = secrets.kind;
  }
  $effect(() => {
    untrack(() => {
      baseUrl = app.settings.ai.baseUrl;
      void refreshKey();
    });
  });
  const ai = (patch: Partial<typeof s.ai>): Promise<void> => set('ai', { ...app.settings.ai, ...patch });
  async function saveKey(): Promise<void> {
    if (!keyInput.trim()) return;
    await secrets.set(OPENAI_KEY_SECRET, keyInput.trim());
    keyInput = '';
    await refreshKey();
    app.toast('success', { key: 'toast.keySaved' });
  }
  async function removeKey(): Promise<void> {
    await secrets.remove(OPENAI_KEY_SECRET);
    await refreshKey();
    app.toast('success', { key: 'toast.keyRemoved' });
  }
  async function saveBaseUrl(): Promise<void> {
    const problem = await aim.setBaseUrl(baseUrl);
    urlProblem = problem ? tm(problem) : null;
    if (problem) baseUrl = app.settings.ai.baseUrl;
  }
  async function pickProvider(id: string): Promise<void> {
    urlProblem = null;
    await aim.selectProvider(id as (typeof AI_PROVIDERS)[number]);
    baseUrl = app.settings.ai.baseUrl;
  }
  async function unlock(): Promise<void> {
    if (!passphrase || !webSecrets.unlock) return;
    const ok = await webSecrets.unlock(passphrase);
    passphrase = '';
    if (!ok) app.toast('error', { key: 'error.wrongPassword' });
    await refreshKey();
  }

  // ---- Profiles -------------------------------------------------------------------------------
  let profiles = $state<Profile[]>([]);
  let editing = $state<string | null>(null);
  let newName = $state('');
  let newTemplates = $state<string[]>(['identity', 'address', 'contacts']);
  let entry = $state({ label: '', value: '', sensitive: false });
  const current = $derived(profiles.find((p) => p.id === editing) ?? null);
  async function loadProfiles(): Promise<void> {
    profiles = await services.profiles.list();
  }
  $effect(() => {
    if (pane === 'profiles') void loadProfiles();
  });
  async function createProfile(): Promise<void> {
    const p = await app.guard(() => services.profiles.create(newName, newTemplates));
    if (!p) return;
    newName = '';
    await loadProfiles();
    editing = p.id;
  }
  async function setField(p: Profile, key: string, patch: { value?: string; sensitive?: boolean }): Promise<void> {
    const f = p.fields.find((x) => x.key === key)!;
    await app.guard(() => services.profiles.setField(p.id, { ...f, ...patch }));
    await loadProfiles();
  }
  async function addEntry(p: Profile): Promise<void> {
    if (!entry.label.trim()) return;
    await app.guard(() => services.profiles.setField(p.id, { key: entry.label, label: entry.label.trim(), type: 'text' as ProfileFieldType, value: entry.value, sensitive: entry.sensitive }));
    entry = { label: '', value: '', sensitive: false };
    await loadProfiles();
  }
  async function exportProfile(p: Profile): Promise<void> {
    const ref = await services.platform.files.pickSave({ suggestedName: `${p.name}.profile.json`, kind: 'json' });
    if (ref) await app.guard(async () => services.platform.files.write(ref, new TextEncoder().encode(JSON.stringify(await services.profiles.exportJson(p.id), null, 2)), { atomic: true }));
  }
  async function importProfile(): Promise<void> {
    const [ref] = await services.platform.files.pickOpen({ accept: ['json'] });
    if (!ref) return;
    await app.guard(async () => {
      const text = new TextDecoder().decode(await services.platform.files.read(ref));
      let data: unknown = null; // a file that is not JSON is reported like any other file that is not a profile
      try {
        data = JSON.parse(text);
      } catch {
        /* handled by importJson */
      }
      return services.profiles.importJson(data);
    });
    await loadProfiles();
  }
  async function removeProfile(p: Profile): Promise<void> {
    if (!(await app.prompts.confirm({ key: 'confirm.removeProfile' }, { danger: true, confirmLabel: { key: 'action.delete' } }))) return;
    await services.profiles.remove(p.id);
    editing = null;
    await loadProfiles();
  }

  // ---- General --------------------------------------------------------------------------------
  let recentCount = $state(0);
  $effect(() => {
    void v;
    if (pane === 'general') void services.recents.list().then((l) => (recentCount = l.length));
  });
  async function clearRecents(): Promise<void> {
    if (!(await app.prompts.confirm({ key: 'confirm.clearRecents' }, { danger: true, confirmLabel: { key: 'action.clear' } }))) return;
    await services.recents.clear();
    recentCount = 0;
    app.toast('success', { key: 'toast.recentsCleared' });
    app.changed.emit();
  }
  async function deleteData(): Promise<void> {
    if (!(await app.prompts.confirm({ key: 'confirm.deleteData' }, { danger: true, confirmLabel: { key: 'action.delete' } }))) return;
    await deleteAllData(services.platform.db, secrets, [OPENAI_KEY_SECRET]);
    await services.recovery.discardAll();
    webSecrets.forgetDevice?.();
    await app.resetSettings();
    app.toast('success', { key: 'toast.dataDeleted' });
    await refreshKey();
  }
  let copied = $state(false);
  async function copyDiagnostics(): Promise<void> {
    const info = services.platform.app;
    await services.platform.clipboard.writeText(`Folio ${info.version} · ${info.os} · ${info.locale}\n${navigator.userAgent}\n\n${services.platform.log.dump()}`).catch(() => undefined);
    copied = true;
  }
  /** Rename keeps the old name when the new one is rejected (empty) and says why. */
  async function renameProfile(id: string, previous: string, input: HTMLInputElement): Promise<void> {
    const ok = await app.guard(async () => {
      await services.profiles.rename(id, input.value);
      return true;
    });
    if (!ok) input.value = previous;
    await loadProfiles();
  }
  async function resetAll(): Promise<void> {
    if (!(await app.prompts.confirm({ key: 'confirm.resetSettings' }, { danger: true, confirmLabel: { key: 'settings.reset' } }))) return;
    await app.resetSettings();
    app.toast('success', { key: 'toast.settingsReset' });
  }
  /** Out-of-range values go back to the last good one and the toast says what is allowed. */
  async function setRecoveryInterval(input: HTMLInputElement): Promise<void> {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 5 || value > 600) {
      input.value = String(s.recoveryIntervalSec);
      app.toast('warning', { key: 'settings.recoveryIntervalRange' });
      return;
    }
    await app.guard(() => set('recoveryIntervalSec', value));
  }
</script>

<Dialog title={t('settings.title')} width={800} onclose={() => ui.closeDialog()}>
  <div class="setwrap">
    <nav class="setnav" aria-label={t('settings.title')}>
      {#each PANES as p (p)}<button class:on={pane === p} aria-current={pane === p ? 'page' : undefined} onclick={() => ((pane = p), (editing = null))}>{t(`settings.${p}`)}</button>{/each}
    </nav>
    <div class="setpane">
      {#if pane === 'appearance'}
        <div class="field"><span class="lab">{t('settings.theme')}</span>
          <div class="seg seg-inline" role="radiogroup" aria-label={t('settings.theme')}>
            {#each [['light', 'sun'], ['dark', 'moon'], ['system', 'monitor']] as [id, icon] (id)}
              <button role="radio" class:on={s.theme === id} aria-checked={s.theme === id} onclick={() => set('theme', id as 'light')}><Icon name={icon!} />{t(`settings.theme.${id}`)}</button>
            {/each}
          </div>
        </div>
        <div class="field"><span class="lab">{t('settings.accent')}</span>
          <div class="row">{#each ACCENTS as c (c)}<button class="swatch" class:on={s.accentColor === c} style="background:{c};width:24px;height:24px;flex:none" aria-label={c} aria-pressed={s.accentColor === c} onclick={() => set('accentColor', c)}></button>{/each}</div>
        </div>
        <div class="field"><label for="uis">{t('settings.uiScale')} <b>{Math.round(s.uiScale * 100)}%</b></label><input id="uis" type="range" min="90" max="150" step="10" value={Math.round(s.uiScale * 100)} onchange={(e) => set('uiScale', Number(e.currentTarget.value) / 100)} /></div>
        <div class="togrow"><div>{t('settings.reduceMotion')}<small>{t('settings.reduceMotionHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.reduceMotion')} checked={s.reduceMotion} onchange={(e) => set('reduceMotion', e.currentTarget.checked)} /></div>
        <div class="g2">
          <div class="field"><label for="dz">{t('settings.defaultZoom')}</label>
            <select id="dz" value={String(s.defaultZoom)} onchange={(e) => set('defaultZoom', /^\d+$/.test(e.currentTarget.value) ? Number(e.currentTarget.value) : (e.currentTarget.value as 'fit-width'))}>
              <option value="fit-width">{t('cmd.fitWidth')}</option><option value="fit-page">{t('cmd.fitPage')}</option><option value="actual">{t('cmd.actualSize')}</option>{#each [75, 125, 150, 200] as z (z)}<option value={String(z)}>{z}%</option>{/each}
            </select>
          </div>
          <div class="field"><label for="dl">{t('settings.defaultLayout')}</label>
            <select id="dl" value={s.defaultLayout} onchange={(e) => set('defaultLayout', e.currentTarget.value as 'single')}><option value="continuous">{t('cmd.layoutContinuous')}</option><option value="single">{t('cmd.layoutSingle')}</option><option value="two-page">{t('cmd.layoutTwoPage')}</option></select>
          </div>
        </div>
      {:else if pane === 'smartFill'}
        <div class="callout info"><Icon name="shield-check" /><span>{t('settings.ai.info')}</span></div>
        <div class="togrow"><div>{t('settings.ai.enable')}</div><input type="checkbox" class="tog" aria-label={t('settings.ai.enable')} checked={s.ai.enabled} onchange={(e) => ai({ enabled: e.currentTarget.checked })} /></div>
        <div class="field"><label for="aip">{t('settings.ai.provider')}</label>
          <div class="row"><select id="aip" value={aim.provider} onchange={(e) => pickProvider(e.currentTarget.value)} style="flex:1">{#each AI_PROVIDERS as id (id)}<option value={id}>{t(`settings.ai.provider.${id}`)}</option>{/each}</select>
            {#if aim.local}<span class="chip acc" style="flex:none" data-testid="ai-local"><Icon name="shield-check" size={12} />{t('settings.ai.badge.local')}</span>{/if}
          </div>
        </div>
        {#if !desktop}<div class="callout"><Icon name="info" /><span>{tm(aim.corsHint)}</span></div>{/if}
        <div class="field"><label for="ak">{t('settings.ai.key')}</label>
          <div class="row"><input id="ak" type="password" bind:value={keyInput} placeholder={hasKey ? '••••••••••••••••' : 'sk-…'} autocomplete="off" style="flex:1" /><button class="btn" style="flex:none" disabled={!keyInput.trim()} onclick={saveKey}>{t('settings.ai.saveKey')}</button>{#if hasKey}<button class="btn danger" style="flex:none" onclick={removeKey}>{t('settings.ai.removeKey')}</button>{/if}</div>
          <span class="hint">{hasKey ? `${t('settings.ai.keySet')} ` : ''}{aim.keyRequired ? t(`settings.ai.keyHint.${secretKind}`) : t('settings.ai.keyOptional')}</span>
        </div>
        {#if !desktop && webSecrets.unlock && secretKind !== 'passphrase-encrypted'}
          <div class="field"><label for="pp">{t('settings.ai.passphrase')}</label>
            <div class="row"><input id="pp" type="password" bind:value={passphrase} placeholder={t('settings.ai.passphrasePlaceholder')} autocomplete="off" style="flex:1" /><button class="btn" style="flex:none" disabled={!passphrase} onclick={unlock}>{t('settings.ai.unlock')}</button></div>
            <span class="hint">{t('settings.ai.passphraseHint')}</span>
          </div>
        {/if}
        <div class="field"><label for="bu">{t('settings.ai.baseUrl')}</label><div class="row"><input id="bu" type="text" bind:value={baseUrl} onchange={saveBaseUrl} style="flex:1" /><button class="btn" style="flex:none" disabled={aim.testing} onclick={() => aim.test()}>{t('settings.ai.test')}</button></div><span class="hint">{t('settings.ai.baseUrlHint')}</span>
          {#if urlProblem}<span class="err" role="alert">{urlProblem}</span>{/if}
          {#if aim.testing}<span class="note" role="status">{t('settings.ai.caps.checking')}</span>{:else if aim.result}<span class={aim.result.ok ? 'okc' : 'err'} role="status">{tm(aim.result.message)}</span>{/if}
        </div>
        <div class="field"><label for="mdl">{t('settings.ai.model')}</label><input id="mdl" type="text" list="mdls" value={s.ai.model} onchange={(e) => aim.setModel(e.currentTarget.value)} /><datalist id="mdls">{#each aim.models as m (m)}<option value={m}></option>{/each}</datalist></div>
        {@const caps = dep(v, aim.capabilities)}
        <div class="field" data-testid="ai-caps"><span class="lab">{t('settings.ai.caps.title')}</span>
          {#if caps.probed}
            <div class="row" style="gap:16px"><span>{t('settings.ai.caps.images')}: <b>{t(caps.vision ? 'settings.ai.caps.yes' : 'settings.ai.caps.no')}</b></span><span>{t('settings.ai.caps.structured')}: <b>{t(`settings.ai.caps.structured.${caps.structured}`)}</b></span></div>
          {:else}<span class="note">{t('settings.ai.caps.notChecked')}</span>{/if}
          <span class="hint">{t('settings.ai.caps.cost')}</span>
        </div>
        {#if caps.probed && !s.ai.capabilities?.vision}
          <div class="togrow"><div>{t('settings.ai.caps.visionOverride')}<small>{t('settings.ai.caps.visionOverrideHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.ai.caps.visionOverride')} checked={s.ai.visionOverride} onchange={(e) => aim.setVisionOverride(e.currentTarget.checked)} /></div>
        {/if}
        <div class="field"><span class="lab">{t('settings.ai.mode')}</span>
          <div class="radios" role="radiogroup">
            {#each ['mapping_only', 'with_values'] as mode (mode)}
              <label><input type="radio" name="dm" checked={s.ai.mode === mode} onchange={() => ai({ mode: mode as 'mapping_only' })} /><div><b>{t(`settings.ai.mode.${mode}`)}</b><small>{t(`settings.ai.mode.${mode}.d`)}</small></div></label>
            {/each}
          </div>
        </div>
        {@const visionGate = dep(v, aim.visionGate())}
        <div class="togrow"><div>{t('settings.ai.image')}<small>{visionGate.ok ? t('settings.ai.imageHint') : tm(visionGate.reason)}</small></div><input type="checkbox" class="tog" aria-label={t('settings.ai.image')} disabled={!visionGate.ok} checked={s.ai.includeImage && visionGate.ok} onchange={(e) => ai({ includeImage: e.currentTarget.checked })} /></div>
      {:else if pane === 'profiles'}
        {#if current}
          {@const p = current}
          <div class="row"><button class="btn sm ghost" style="flex:none" onclick={() => (editing = null)}><Icon name="chevron-left" /></button><input type="text" value={p.name} aria-label={t('settings.profile.name')} maxlength="60" onchange={(e) => renameProfile(p.id, p.name, e.currentTarget)} />
            {#if !p.isDefault}<button class="btn sm" style="flex:none" onclick={() => services.profiles.setDefault(p.id).then(loadProfiles)}>{t('action.setDefault')}</button>{/if}
          </div>
          <div class="ptable">
            <b class="lab">{t('settings.profile.label')}</b><b class="lab">{t('settings.profile.value')}</b><b class="lab" title={t('settings.profile.sensitiveHint')}>{t('settings.profile.sensitive')}</b><span></span>
            {#each p.fields as f (f.key)}
              <label for="pf-{f.key}" title={f.aliases.join(', ')}>{f.label}</label>
              <input id="pf-{f.key}" type={f.sensitive ? 'password' : f.type === 'date' ? 'date' : 'text'} value={f.value} autocomplete="off" onchange={(e) => setField(p, f.key, { value: e.currentTarget.value })} />
              <input type="checkbox" aria-label="{t('settings.profile.sensitive')}: {f.label}" checked={f.sensitive} onchange={(e) => setField(p, f.key, { sensitive: e.currentTarget.checked })} />
              <button class="ib" onclick={() => services.profiles.removeField(p.id, f.key).then(loadProfiles)} aria-label="{t('action.remove')} {f.label}"><Icon name="x" /></button>
            {/each}
            <input type="text" bind:value={entry.label} placeholder={t('settings.profile.label')} aria-label={t('settings.profile.label')} />
            <input type="text" bind:value={entry.value} placeholder={t('settings.profile.value')} aria-label={t('settings.profile.value')} />
            <input type="checkbox" bind:checked={entry.sensitive} aria-label={t('settings.profile.sensitive')} />
            <button class="ib" disabled={!entry.label.trim()} onclick={() => addEntry(p)} aria-label={t('settings.profile.addEntry')}><Icon name="plus" /></button>
          </div>
          <p class="note">{t('settings.profile.sensitiveHint')}</p>
          <div class="row"><button class="btn sm" onclick={() => exportProfile(p)}>{t('settings.profile.export')}</button><span class="grow"></span><button class="btn sm danger" onclick={() => removeProfile(p)}><Icon name="trash-2" />{t('action.delete')}</button></div>
        {:else}
          {#if profiles.length === 0}<p class="note">{t('settings.profile.empty')}</p>{/if}
          <ul class="rlist">
            {#each profiles as p (p.id)}
              <li><Icon name="user" /><b>{p.name}</b>{#if p.isDefault}<span class="chip acc">{t('action.default')}</span>{/if}<small>{t('settings.profile.entries', { count: p.fields.filter((f) => f.value).length })}</small><button class="btn sm" onclick={() => (editing = p.id)}>{t('action.edit')}</button></li>
            {/each}
          </ul>
          <div class="field"><label for="pn">{t('settings.profile.new')}</label>
            <div class="row"><input id="pn" type="text" maxlength="60" bind:value={newName} placeholder={t('settings.profile.name')} style="flex:1" /><button class="btn" style="flex:none" disabled={!newName.trim()} onclick={createProfile}><Icon name="plus" />{t('action.add')}</button><button class="btn" style="flex:none" onclick={importProfile}>{t('settings.profile.import')}</button></div>
            <div class="row" style="flex-wrap:wrap;gap:10px">
              <span class="note" style="flex:none">{t('settings.profile.templates')}</span>
              {#each Object.keys(PROFILE_TEMPLATES) as k (k)}<label style="width:auto;display:flex;gap:4px;align-items:center;flex:none"><input type="checkbox" bind:group={newTemplates} value={k} />{t(`settings.profile.template.${k}`)}</label>{/each}
            </div>
          </div>
          <p class="note">{t('settings.profile.hint')}</p>
        {/if}
      {:else if pane === 'general'}
        <div class="g2">
          <div class="field"><label for="un">{t('settings.units')}</label><select id="un" value={s.units} onchange={(e) => set('units', e.currentTarget.value as 'mm')}><option value="mm">{t('settings.units.mm')}</option><option value="in">{t('settings.units.in')}</option><option value="pt">{t('settings.units.pt')}</option></select></div>
          <div class="field"><label for="lg">{t('settings.language')}</label><select id="lg" value={s.language} onchange={(e) => set('language', e.currentTarget.value)}><option value="en">{t('settings.language.en')}</option></select></div>
          <div class="field"><label for="df">{t('settings.dateFormat')}</label><select id="df" value={s.dateFormat} onchange={(e) => set('dateFormat', e.currentTarget.value as 'iso')}>{#each DATE_FORMATS as f (f)}<option value={f}>{formatDate(new Date(), f, 'en')}</option>{/each}</select></div>
          <div class="field"><label for="ri">{t('settings.recoveryInterval')}</label><input id="ri" type="number" min="5" max="600" value={s.recoveryIntervalSec} onchange={(e) => setRecoveryInterval(e.currentTarget)} /></div>
        </div>
        <div class="field"><label for="au">{t('settings.author')}</label><input id="au" type="text" value={s.authorName} onchange={(e) => set('authorName', e.currentTarget.value)} /><span class="hint">{t('settings.authorHint', { name: services.platform.app.userName ?? '—' })}</span></div>
        <div class="togrow"><div>{t('settings.keepBackup')}<small>{t('settings.keepBackupHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.keepBackup')} checked={s.keepBackup} onchange={(e) => set('keepBackup', e.currentTarget.checked)} /></div>
        <div class="togrow"><div>{t('settings.flattenStamps')}<small>{t('settings.flattenStampsHint')}</small></div><input type="checkbox" class="tog" aria-label={t('settings.flattenStamps')} checked={s.flattenStampsOnSave} onchange={(e) => set('flattenStampsOnSave', e.currentTarget.checked)} /></div>
        <div class="togrow"><div>{t('sign.encrypt')}<small>{t('sign.encryptHint')}</small></div><input type="checkbox" class="tog" aria-label={t('sign.encrypt')} checked={s.encryptSignatures} onchange={(e) => set('encryptSignatures', e.currentTarget.checked)} /></div>
        <div class="togrow"><div>{t('settings.recents')}<small>{t('settings.recentsCount', { count: recentCount })}</small></div><button class="btn sm danger" onclick={clearRecents}>{t('settings.clearList')}</button></div>
        <div class="togrow"><div>{t('settings.reset')}</div><button class="btn sm" onclick={resetAll}>{t('settings.reset')}</button></div>
        <div class="togrow"><div>{t('settings.deleteData')}<small>{t('settings.deleteDataHint')}</small></div><button class="btn sm danger" onclick={deleteData}><Icon name="trash-2" />{t('action.delete')}</button></div>
      {:else if pane === 'privacy'}
        <div class="callout info"><Icon name="shield" /><span>{t('settings.privacy.body1')}</span></div>
        <p style="margin:0">{t('settings.privacy.body2')}</p>
        <p style="margin:0">{t('settings.privacy.body3')}</p>
        <p style="margin:0">{t('settings.privacy.body4')}</p>
      {:else}
        <div class="row"><span class="brand" style="cursor:default;flex:none"><i class="logo" style="width:36px;height:36px;font-size:18px;border-radius:10px">F</i></span><div><b style="font-size:15px">Folio</b><div class="note">{t('settings.about.version', { version: services.platform.app.version || VERSION })}</div></div></div>
        <p class="note">{t('settings.about.body')}</p>
        {#if desktop}<p class="note">{t('settings.safeGraphics')}</p>{/if}
        <div class="row"><button class="btn" style="flex:none" onclick={copyDiagnostics}>{copied ? t('action.copied') : t('action.copyDiagnostics')}</button></div>
      {/if}
    </div>
  </div>
  {#snippet footer()}<button class="btn primary" onclick={() => ui.closeDialog()}>{t('action.done')}</button>{/snippet}
</Dialog>
