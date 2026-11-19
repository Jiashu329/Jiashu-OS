import { parseRecipeTextDraft } from './recipe-text-draft.ts';
import { normalizeRecipeLink } from './recipe-link.ts';

function recipesClient(parseText: typeof parseRecipeTextDraft, approvedLink: typeof normalizeRecipeLink) {
  type Recipe = {
    id: string; title: string; source: string; sourceUrl: string | null; sourceAuthor: string | null;
    ingredients: string; steps: string; servings: string; note: string; revision: number;
  };
  type Definition = Pick<Recipe, 'title' | 'ingredients' | 'steps' | 'servings' | 'note'>;
  type Preview = {
    title?: string; author?: string; description?: string; ingredients?: string[]; steps?: string[];
  };
  type Operation = {
    key: string; recipeId: string | null;
    body: Definition & { sourceUrl?: string; sourceTitle?: string; sourceAuthor?: string; expectedRevision?: number };
  };
  type RequestError = Error & { status?: number; code?: string };
  const page = window as Window & {
    JiashuAccountSession?: { changed: boolean; problem: string };
    JiashuDrafts?: {
      ready(): Promise<string | null>;
      get(id: string): { kind: string; data: Operation } | null;
      save(id: string, label: string, data: Operation, options: { url: string; kind: 'pending' }): boolean;
      clearConfirmed(id: string): boolean;
      problem: string;
    };
    JiashuDraftGuards?: {
      register(options: {
        form: HTMLFormElement; dialog: HTMLDialogElement; label: string; isBusy(): boolean;
        isBlocked(): boolean; durableContext(): string;
      }): { reset(): void; saved(): void; failed(): void; close(): void };
    };
  };
  const endpoint = '/api/health/nutrition/recipes';
  const pagePath = '/health/nutrition/recipes';
  const pendingId = 'recipes:pending';
  const sources: Record<string, string> = { xiaohongshu: '小红书', xiachufang: '下厨房', own: '自制菜' };
  const el = <T = HTMLElement>(id: string) => document.getElementById(id) as unknown as T;
  const list = el('recipes-list');
  const listStatus = el('recipes-status');
  const add = el<HTMLButtonElement>('recipes-add');
  const more = el<HTMLButtonElement>('recipes-more');
  const pendingBanner = el('recipes-pending');
  const pendingMessage = el('recipes-pending-message');
  const retry = el<HTMLButtonElement>('recipes-retry');
  const editor = el<HTMLDialogElement>('recipe-editor');
  const detail = el<HTMLDialogElement>('recipe-detail');
  const detailBody = el('recipe-detail-body');
  const form = el<HTMLFormElement>('recipe-form');
  const fieldset = el<HTMLFieldSetElement>('recipe-fields');
  const formStatus = el('recipe-form-status');
  const previewStatus = el('recipe-preview-status');
  const openOriginal = el<HTMLAnchorElement>('recipe-open-original');
  const sourceInput = el<HTMLTextAreaElement>('recipe-source-input');
  const previewButton = el<HTMLButtonElement>('recipe-preview');
  const save = el<HTMLButtonElement>('recipe-save');
  const originalText = el<HTMLTextAreaElement>('recipe-original-text');
  const fields = {
    title: el<HTMLInputElement>('recipe-title'), ingredients: el<HTMLTextAreaElement>('recipe-ingredients'),
    steps: el<HTMLTextAreaElement>('recipe-steps'), servings: el<HTMLInputElement>('recipe-servings'),
    note: el<HTMLTextAreaElement>('recipe-note'),
  };
  const fieldKeys = ['title', 'ingredients', 'steps', 'servings', 'note'] as const;
  const imported: Partial<Definition> = {};
  let preview: Preview | null = null;
  let viewing: Recipe | null = null;
  let editing: Recipe | null = null;
  let pending: Operation | null = null;
  let ready = false;
  let saving = false;
  let previewBusy = false;
  let previewVersion = 0;
  let listVersion = 0;
  let detailVersion = 0;
  let nextOffset: number | null = null;
  let listQuery = new URLSearchParams();
  const guard = page.JiashuDraftGuards?.register({
    form, dialog: editor, label: '菜谱', isBusy: () => saving,
    isBlocked: () => saving || pending !== null || Boolean(page.JiashuAccountSession?.changed),
    durableContext: () => editing?.id ?? 'new',
  });

  function status(node: HTMLElement, message: string, error = false) {
    node.textContent = message;
    node.toggleAttribute('data-error', error);
  }
  function validId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  }
  function controls() {
    const lock = !ready || saving || pending !== null || Boolean(page.JiashuAccountSession?.changed);
    add.disabled = lock;
    fieldset.disabled = lock;
    save.disabled = lock;
    retry.disabled = saving || Boolean(page.JiashuAccountSession?.changed);
    el<HTMLButtonElement>('recipe-edit').disabled = lock;
    previewButton.disabled = lock || previewBusy || !sourceInput.value.trim();
    pendingBanner.hidden = pending === null;
  }
  async function request<T>(path: string, options: { method?: string; body?: object; key?: string } = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, {
        method: options.method ?? 'GET', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      const payload = await response.json();
      if (!response.ok) {
        const details = payload as { error?: unknown; code?: unknown } | null;
        const error: RequestError = new Error(typeof details?.error === 'string' ? details.error : '请求未完成，请重试。');
        error.status = response.status;
        if (typeof details?.code === 'string') error.code = details.code;
        throw error;
      }
      return payload as T;
    } finally { clearTimeout(timeout); }
  }
  function message(error: unknown, fallback: string) {
    return error instanceof Error && typeof (error as RequestError).status === 'number' ? error.message : fallback;
  }
  function card(recipe: Recipe) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recipe-card';
    const title = document.createElement('strong');
    title.textContent = recipe.title;
    const caption = document.createElement('small');
    caption.textContent = [sources[recipe.source], recipe.sourceAuthor].filter(Boolean).join(' · ');
    button.appendChild(title);
    button.appendChild(caption);
    button.addEventListener('click', () => { void readDetail(recipe.id); });
    item.appendChild(button);
    return item;
  }
  async function loadList(append = false) {
    const version = ++listVersion;
    if (!append) {
      listQuery = new URLSearchParams({
        q: el<HTMLInputElement>('recipes-query').value.trim(), source: el<HTMLSelectElement>('recipes-source').value,
      });
      nextOffset = null;
      list.replaceChildren();
      more.hidden = true;
    }
    const query = new URLSearchParams(listQuery);
    query.set('offset', String(nextOffset ?? 0));
    more.disabled = true;
    status(listStatus, '正在读取菜谱…');
    try {
      const result = await request<{ recipes: Recipe[]; nextOffset: number | null }>(endpoint + '?' + query);
      if (version !== listVersion) return;
      for (const recipe of result.recipes) list.appendChild(card(recipe));
      nextOffset = result.nextOffset;
      more.hidden = nextOffset === null;
      status(listStatus, list.children.length ? '' : '没有符合条件的菜谱。');
    } catch (error) {
      if (version === listVersion) status(listStatus, message(error, '暂时无法读取菜谱，请重试。'), true);
    } finally {
      if (version === listVersion) more.disabled = false;
    }
  }
  function showDetail(recipe: Recipe) {
    viewing = recipe;
    el('recipe-detail-title').textContent = recipe.title;
    const meta = document.createElement('p');
    meta.className = 'recipe-details-meta';
    meta.textContent = [sources[recipe.source], recipe.sourceAuthor].filter(Boolean).join(' · ');
    detailBody.replaceChildren(meta);
    const source = approvedLink(recipe.sourceUrl ?? '');
    if (source) {
      const link = document.createElement('a');
      link.className = 'recipe-button';
      link.textContent = '打开' + sources[source.source] + '原文';
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      detailBody.appendChild(link);
    }
    const sections = [['份量', recipe.servings], ['食材与用量', recipe.ingredients], ['做法', recipe.steps], ['备注', recipe.note]];
    for (const [label, content] of sections) {
      if (!content) continue;
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = label;
      const text = document.createElement('p');
      text.textContent = content;
      section.appendChild(heading);
      section.appendChild(text);
      detailBody.appendChild(section);
    }
    if (!recipe.ingredients && !recipe.steps && source) {
      const hint = document.createElement('p');
      hint.className = 'recipe-details-meta';
      hint.textContent = '已保存原链接，可继续补充食材和做法。';
      detailBody.appendChild(hint);
    }
    if (!detail.open) detail.showModal();
  }
  async function readDetail(id: string) {
    if (!validId(id)) return;
    const version = ++detailVersion;
    try {
      const { recipe } = await request<{ recipe: Recipe }>(endpoint + '/' + id);
      if (version === detailVersion && recipe.id === id && !editor.open) showDetail(recipe);
    } catch (error) {
      if (version === detailVersion) status(listStatus, message(error, '暂时无法打开菜谱，请重试。'), true);
    }
  }
  function applyField(key: keyof Definition, value: string | undefined) {
    const field = fields[key];
    if (!value || (field.value.trim() && field.value !== imported[key])) return false;
    field.value = value.slice(0, field.maxLength).replace(/[\uD800-\uDBFF]$/u, '');
    imported[key] = field.value;
    return true;
  }
  function syncOriginalLink() {
    const source = approvedLink(sourceInput.value);
    openOriginal.hidden = source === null;
    if (source) {
      openOriginal.href = source.url;
      openOriginal.textContent = '打开' + sources[source.source] + '原文';
    } else openOriginal.removeAttribute('href');
  }
  function onSourceChange() {
    ++previewVersion;
    preview = null;
    previewBusy = false;
    for (const key of fieldKeys) {
      if (imported[key] === fields[key].value) fields[key].value = '';
      delete imported[key];
    }
    status(previewStatus, '');
    syncOriginalLink();
    controls();
  }
  function openEditor(recipe: Recipe | null = null) {
    if (!ready || saving || pending || page.JiashuAccountSession?.changed) return;
    ++detailVersion;
    editing = recipe;
    if (detail.open) detail.close();
    form.reset();
    sourceInput.required = recipe === null;
    fields.title.required = recipe !== null;
    el('recipe-import').hidden = recipe !== null;
    el<HTMLDetailsElement>('recipe-paste').open = false;
    el('recipe-editor-title').textContent = recipe ? '编辑菜谱' : '保存菜谱链接';
    status(formStatus, '');
    onSourceChange();
    for (const key of fieldKeys) fields[key].value = recipe?.[key] ?? '';
    editor.showModal();
    guard?.reset();
    (recipe ? fields.title : sourceInput).focus();
  }
  async function readPreview() {
    if (previewBusy || pending || saving || !editor.open) return;
    const source = approvedLink(sourceInput.value);
    if (!source) {
      status(previewStatus, '请粘贴有效的小红书或下厨房菜谱链接。', true);
      return;
    }
    const version = ++previewVersion;
    previewBusy = true;
    controls();
    status(previewStatus, '正在读取公开原文…');
    try {
      const result = await request<{ preview: Preview | null }>(endpoint + '/preview', {
        method: 'POST', body: { sourceUrl: source.url },
      });
      if (version !== previewVersion || !editor.open || saving || pending) return;
      preview = result.preview;
      if (!preview) {
        status(previewStatus, '暂时无法自动读取原文。仍可保存链接，也可以打开原文后粘贴文字。');
        return;
      }
      applyField('title', preview.title);
      applyField('ingredients', preview.ingredients?.join('\n'));
      applyField('steps', preview.steps?.join('\n'));
      if (preview.description && !preview.ingredients?.length && !preview.steps?.length) {
        applyField('note', parseText(preview.description).note);
      }
      form.dispatchEvent(new Event('change', { bubbles: true }));
      status(previewStatus, '已带入可读取的菜谱资料。核对后可保存。');
    } catch (error) {
      if (version === previewVersion && editor.open) {
        status(previewStatus, message(error, '暂时无法自动读取原文。可直接保存链接，或粘贴原文文字。'), true);
      }
    } finally {
      if (version === previewVersion) {
        previewBusy = false;
        controls();
      }
    }
  }
  function applyOriginal() {
    const parsed = parseText(originalText.value);
    if (!parsed.note) {
      status(previewStatus, '请先粘贴菜谱原文。', true);
      return;
    }
    const ingredients = applyField('ingredients', parsed.ingredients);
    const steps = applyField('steps', parsed.steps);
    const note = applyField('note', parsed.note);
    form.dispatchEvent(new Event('change', { bubbles: true }));
    status(previewStatus, ingredients || steps ? '已带入可识别的食材和做法。'
      : note ? '原文已带入备注。' : '已保留你的填写，可把原文中的食材和做法粘贴到对应栏目。');
  }

  function currentPending(): Operation | null {
    const record = page.JiashuDrafts?.get(pendingId);
    const operation = record?.data;
    return record?.kind === 'pending' && operation && validId(operation.key)
      && (operation.recipeId === null || validId(operation.recipeId)) && typeof operation.body?.title === 'string'
      ? operation : null;
  }
  function syncPending() {
    pending = currentPending();
    if (pending) status(pendingMessage, '有一笔菜谱保存待确认。');
    controls();
  }
  async function send(operation: Operation) {
    if (saving || page.JiashuAccountSession?.changed) return;
    saving = true;
    controls();
    status(formStatus, '正在保存…');
    if (pending) status(pendingMessage, '正在核对原操作…');
    let saved: Recipe | null = null;
    let error: unknown = null;
    try {
      const path = endpoint + (operation.recipeId ? '/' + operation.recipeId : '');
      const result = await request<{ recipe: Recipe }>(path, {
        method: operation.recipeId ? 'PATCH' : 'POST', body: operation.body, key: operation.key,
      });
      if (result.recipe?.id !== (operation.recipeId ?? operation.key)) throw new Error('Missing write receipt');
      saved = result.recipe;
    } catch (failure) {
      error = failure;
      if ((failure as RequestError | null)?.code === 'RECIPE_ALREADY_SAVED' && operation.body.sourceUrl) {
        try {
          const result = await request<{ recipe: Recipe }>(endpoint + '?' + new URLSearchParams({ sourceUrl: operation.body.sourceUrl }));
          if (validId(result.recipe?.id)) saved = result.recipe;
        } catch { /* The original response has confirmed that no new recipe was written. */ }
      }
    }
    saving = false;
    if (page.JiashuAccountSession?.changed) {
      controls();
      guard?.failed();
      return;
    }
    if (saved || [400, 404, 409, 413, 415, 422].includes((error as RequestError | null)?.status ?? 0)) {
      const latest = currentPending();
      if (latest?.key !== operation.key) pending = latest;
      else if (page.JiashuDrafts?.clearConfirmed(pendingId)) pending = null;
    }
    controls();
    if (pending) {
      status(pendingMessage, message(error, '暂时无法确认保存结果，请继续核对原操作。'), true);
      editor.close();
      retry.focus();
      guard?.failed();
      return;
    }
    if (saved) {
      guard?.saved();
      editor.close();
      showDetail(saved);
      void loadList();
    } else {
      guard?.failed();
      status(editor.open ? formStatus : listStatus, message(error, '菜谱未保存，请重试。'), true);
    }
  }
  function submit() {
    if (!ready || saving || page.JiashuAccountSession?.changed) return;
    syncPending();
    if (pending) return;
    const source = approvedLink(sourceInput.value);
    if (!editing && !source) {
      status(formStatus, '请粘贴有效的小红书或下厨房菜谱链接。', true);
      sourceInput.focus();
      return;
    }
    const body: Operation['body'] = {
      title: fields.title.value.trim() || (source ? sources[source.source] + '菜谱' : ''),
      ingredients: fields.ingredients.value, steps: fields.steps.value,
      servings: fields.servings.value, note: fields.note.value,
    };
    if (editing) body.expectedRevision = editing.revision;
    else if (source) {
      body.sourceUrl = source.url;
      if (preview?.title) body.sourceTitle = preview.title;
      if (preview?.author) body.sourceAuthor = preview.author;
    }
    if (typeof crypto.randomUUID !== 'function') {
      status(formStatus, '当前浏览器无法生成提交标识，请从安全连接打开页面。', true);
      return;
    }
    const operation: Operation = { key: crypto.randomUUID(), recipeId: editing?.id ?? null, body };
    if (!page.JiashuDrafts?.save(pendingId, '菜谱保存待确认', operation, { url: pagePath, kind: 'pending' })) {
      status(formStatus, page.JiashuDrafts?.problem || '浏览器无法保留提交信息，请重试。', true);
      return;
    }
    pending = operation;
    void send(operation);
  }

  add.addEventListener('click', () => openEditor());
  retry.addEventListener('click', () => { const operation = currentPending(); if (operation) void send(operation); });
  el<HTMLFormElement>('recipes-filter').addEventListener('submit', event => { event.preventDefault(); void loadList(); });
  el('recipes-source').addEventListener('change', () => { void loadList(); });
  more.addEventListener('click', () => { if (nextOffset !== null) void loadList(true); });
  el('recipe-cancel').addEventListener('click', () => { if (!saving) { if (guard) guard.close(); else editor.close(); } });
  editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  editor.addEventListener('close', () => { ++previewVersion; previewBusy = false; });
  el('recipe-detail-close').addEventListener('click', () => detail.close());
  el('recipe-edit').addEventListener('click', () => { if (viewing) openEditor(viewing); });
  sourceInput.addEventListener('input', onSourceChange);
  previewButton.addEventListener('click', () => { void readPreview(); });
  el('recipe-apply-text').addEventListener('click', applyOriginal);
  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  for (const event of ['jiashu-account-changed', 'jiashu-account-signed-out']) {
    document.addEventListener(event, () => {
      viewing = null;
      if (detail.open) detail.close();
      list.replaceChildren();
      ++listVersion;
      ++detailVersion;
      controls();
      const error = page.JiashuAccountSession?.problem || '请重新登录后继续。';
      status(listStatus, error, true);
      if (editor.open) status(formStatus, error, true);
    });
  }
  document.addEventListener('jiashu-work-changed', () => { if (!saving && ready) syncPending(); });
  void page.JiashuDrafts?.ready().then(owner => {
    ready = Boolean(owner);
    syncPending();
    if (ready) void loadList();
    else status(listStatus, page.JiashuDrafts?.problem || '请刷新页面或重新登录后重试。', true);
  });
}

export function renderRecipesScript(): string {
  return '(' + recipesClient.toString() + ')(' + parseRecipeTextDraft.toString() + ',' + normalizeRecipeLink.toString() + ');';
}
