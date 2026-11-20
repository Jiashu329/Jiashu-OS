/** Extract explicitly labeled fields from an original recipe or public excerpt. */
export function parseRecipeTextDraft(text: string): { ingredients: string; steps: string; note: string } {
  // This function also runs as a standalone script in the recipe editor.
  const original = text.replace(/\r\n/g, '\n').replace(/[\r\u0085\u2028\u2029]/g, '\n')
    // oxlint-disable-next-line no-control-regex -- Strip control and direction-changing characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, '')
    .trim();
  const ingredientsHeading = /^(?:准备材料|食材|用料|材料)(?:\s*[：:]|$)/u;
  const stepsHeading = /^(?:(?:具体步骤|制作步骤|烹饪步骤|做法|步骤)(?:\s*[：:]|$)|.{1,100}的做法步骤$)/u;
  const afterRecipe = /^(?:.{1,100}的)?(?:小贴士|小技巧|提示|评论)(?:\s*[：:]|$)/u;
  const numberedStep = /^(?:步骤\s*([0-9０-９]{1,2})(?:[.．、)）：:]|\s+|$)|([0-9０-９]{1,2})(?:\uFE0F?\u20E3|[.．、)）：:]))\s*/u;

  function bounded(value: string, limit: number): string {
    if (value.length <= limit) return value;
    if (typeof Intl.Segmenter === 'function') {
      const segments = new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value);
      for (const { index, segment } of segments) {
        if (index + segment.length > limit) return value.slice(0, index).trim();
      }
    }
    return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '').trim();
  }

  function beforeTopics(line: string): string {
    const topic = /#[^#]{1,80}\[话题\]#|(?:^|\s)#[^\s#]+/u.exec(line);
    return line.slice(0, topic?.index ?? line.length).trim();
  }

  function step(line: string): { number: number; text: string } | null {
    const match = numberedStep.exec(line);
    if (!match) return null;
    const number = Number((match[1] ?? match[2]).normalize('NFKC'));
    const content = line.slice(match[0].length).trim();
    return number > 0 && (match[1] !== undefined || content) ? { number, text: content } : null;
  }

  function sourceLines(source: string): string[] {
    const lines = source.split('\n');
    if (lines.length !== 1) return lines;

    // Public share excerpts can flatten lines into spaces. Restore boundaries
    // only when explicit headings and consecutive step markers identify them.
    const ingredients = /(?:^|\s)(?:准备材料|食材|用料|材料)\s*[：:]/u.exec(source);
    if (!ingredients) return lines;
    const fromIngredients = source.slice(ingredients.index).trimStart();
    const steps = /\s(?:具体步骤|制作步骤|烹饪步骤|做法|步骤)\s*[：:]/u.exec(fromIngredients);
    if (!steps) return lines;
    const ingredientLine = fromIngredients.slice(0, steps.index).trim();
    const stepText = beforeTopics(fromIngredients.slice(steps.index + steps[0].length).split('\t', 1)[0]);
    const markers = [...stepText.matchAll(/(?:^|\s)(?:[0-9０-９]{1,2}\uFE0F?\u20E3|步骤\s*[0-9０-９]{1,2}[.．、)）：:])/gu)];
    if (markers.length < 2 || markers[0].index !== 0) return [ingredientLine];
    const stepLines = markers.map((marker, index) => stepText.slice(marker.index, markers[index + 1]?.index).trim());
    if (!stepLines.every((line, index) => {
      const item = step(line);
      return item?.number === index + 1 && item.text !== '';
    })) return [ingredientLine];
    return [ingredientLine, '步骤：', ...stepLines];
  }

  let section: 'ingredients' | 'steps' | undefined;
  const ingredientLines: string[] = [];
  const stepLines: string[] = [];
  let sawIngredients = false;
  let sawSteps = false;
  let lastStep = 0;
  let awaitingStepText = false;

  for (const rawLine of sourceLines(bounded(original, 24_000))) {
    let line = rawLine.trim();
    if (line.startsWith('#') || afterRecipe.test(line)) {
      section = undefined;
      continue;
    }
    if (!line) {
      if (section === 'ingredients' && ingredientLines.length) section = undefined;
      continue;
    }
    const ingredients = ingredientsHeading.exec(line);
    const heading = ingredients ?? stepsHeading.exec(line);
    if (heading) {
      if (ingredients) {
        section = sawIngredients ? undefined : 'ingredients';
        sawIngredients = true;
      } else {
        section = sawSteps ? undefined : 'steps';
        sawSteps = true;
        awaitingStepText = false;
      }
      line = line.slice(heading[0].length).trim();
      if (!line) continue;
      if (section === 'steps' && !step(line)) {
        const content = beforeTopics(line);
        if (content) stepLines.push(content);
        section = undefined;
        continue;
      }
    }

    const content = beforeTopics(line);
    if (section === 'ingredients') {
      ingredientLines.push(...content.split('、').map((item) => item.trim()).filter(Boolean));
    } else if (section === 'steps') {
      const item = step(content);
      if (item && item.number > lastStep) {
        lastStep = item.number;
        awaitingStepText = !item.text;
        if (item.text) stepLines.push(item.text);
      } else if (awaitingStepText && content && !item) {
        stepLines.push(content);
        awaitingStepText = false;
      } else {
        section = undefined;
      }
    }
  }

  return {
    ingredients: bounded(ingredientLines.join('\n'), 3_000),
    steps: bounded(stepLines.join('\n'), 6_000),
    note: bounded(original, 1_000),
  };
}
