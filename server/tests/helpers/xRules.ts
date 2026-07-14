export interface MockXRule {
  id: string;
  value: string;
  tag: string;
}

interface RuleMutationBody {
  add?: Array<{ value: string; tag: string }>;
  delete?: { ids?: string[] };
}

/** Stateful X rules fixture: successful POST mutations are visible to the verification GET. */
export function createStatefulXRulesApi(initial: readonly MockXRule[] = []) {
  let nextId = 1;
  let rules = initial.map((rule) => ({ ...rule }));

  return {
    respond(input: RequestInfo | URL, init?: RequestInit): Response | null {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/rules')) return null;
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return Response.json({ data: rules.map((rule) => ({ ...rule })) });
      if (method !== 'POST') return new Response('method not allowed', { status: 405 });

      const body = JSON.parse(String(init?.body ?? '{}')) as RuleMutationBody;
      const deleteIds = new Set(body.delete?.ids ?? []);
      if (deleteIds.size > 0) rules = rules.filter((rule) => !deleteIds.has(rule.id));
      const added = (body.add ?? []).map((rule) => ({
        id: `mock-rule-${nextId++}`,
        value: rule.value,
        tag: rule.tag,
      }));
      rules.push(...added);
      return Response.json({
        data: added,
        meta: { summary: { created: added.length, deleted: deleteIds.size, not_created: 0 } },
      });
    },
    snapshot(): readonly MockXRule[] {
      return rules.map((rule) => ({ ...rule }));
    },
  };
}
