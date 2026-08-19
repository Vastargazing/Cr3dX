import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const BEGIN = '<!-- probe:begin -->';
const END = '<!-- probe:end -->';

export type SectionState = 'pending' | 'done' | 'failed' | 'skipped';

interface Section {
  id: string;
  title: string;
  state: SectionState;
  body: string;
}

/**
 * Progressive writer for the measurement block of docs/ATTESTCOIN_INTEGRATION.md.
 *
 * Everything between the probe markers is regenerated on every run; prose
 * outside the markers is preserved, so the document can be extended by hand
 * without the probe clobbering it.
 */
export class Report {
  private readonly sections: Section[] = [];
  private meta: Record<string, string> = {};

  constructor(
    private readonly path: string,
    private readonly preamble: string,
  ) {}

  declare(id: string, title: string): void {
    this.sections.push({ id, title, state: 'pending', body: '' });
  }

  setMeta(meta: Record<string, string>): void {
    this.meta = { ...this.meta, ...meta };
    this.flush();
  }

  set(id: string, state: SectionState, body: string): void {
    const s = this.sections.find((x) => x.id === id);
    if (!s) throw new Error(`Unknown report section ${id}`);
    s.state = state;
    s.body = body;
    this.flush();
  }

  fail(id: string, reason: string): void {
    this.set(id, 'failed', `**Not measured in this run.** ${reason}\n`);
  }

  private render(): string {
    const lines: string[] = [];
    lines.push('| Run metadata | |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(this.meta)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    for (const s of this.sections) {
      lines.push(`### ${s.title}`);
      lines.push('');
      if (s.state === 'pending') {
        lines.push('_Measurement did not run._');
        lines.push('');
      } else {
        lines.push(s.body.trimEnd());
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const block = `${BEGIN}\n\n${this.render()}\n${END}`;
    if (existsSync(this.path)) {
      const current = readFileSync(this.path, 'utf8');
      const start = current.indexOf(BEGIN);
      const end = current.indexOf(END);
      if (start !== -1 && end !== -1 && end > start) {
        writeFileSync(this.path, current.slice(0, start) + block + current.slice(end + END.length));
        return;
      }
      writeFileSync(this.path, `${current.trimEnd()}\n\n${block}\n`);
      return;
    }
    writeFileSync(this.path, `${this.preamble.trimEnd()}\n\n${block}\n`);
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
}

export function table(headers: string[], rows: (string | number)[][]): string {
  const out = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const r of rows) out.push(`| ${r.join(' | ')} |`);
  return out.join('\n');
}

export const fmt = {
  int: (n: number | bigint): string => n.toLocaleString('en-US'),
  secs: (s: number): string => {
    if (s >= 3600) {
      const h = Math.floor(s / 3600);
      const m = Math.round((s % 3600) / 60);
      return m === 0 ? `${h}h` : `${h}h ${m}m`;
    }
    const m = Math.floor(s / 60);
    return m >= 1 ? `${m}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
  },
};
