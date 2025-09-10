
import { App, Editor, EditorPosition, MarkdownView, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { spawn } from 'child_process';

type Engine = 'ruff' | 'black';
interface PythonPasteFormatterSettings {
  enabled: boolean;
  engine: Engine;
  ruffPath: string;   // e.g., 'ruff'
  blackPath: string;  // e.g., 'black'
  lineLength: number; // applies to both engines
  scope: 'block' | 'snippet'; // exposed but 'block' recommended
}

const DEFAULT_SETTINGS: PythonPasteFormatterSettings = {
  enabled: true,
  engine: 'ruff',
  ruffPath: 'ruff',
  blackPath: 'black',
  lineLength: 88,
  scope: 'block',
};

export default class PythonPasteFormatterPlugin extends Plugin {
  settings: PythonPasteFormatterSettings;
  private lastPasteAt = 0;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new PythonPasteFormatterSettingTab(this.app, this));

    this.addCommand({
      id: 'format-current-python-codeblock',
      name: 'Format current Python code block',
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const info = findFenceInfo(editor, editor.getCursor());
        if (!info.inside || !isPythonLang(info.lang)) {
          console.warn('Python Paste Formatter: cursor is not inside a Python code fence.');
          return;
        }
        const before = getBlockText(editor, info);
        try {
          const formatted = await this.formatText(before);
          replaceBlock(editor, info, formatted);
        } catch (e) {
          console.error('Python Paste Formatter: format failed', e);
        }
      },
    });

    this.registerEvent(
      this.app.workspace.on('editor-paste', async (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
        try {
          const now = Date.now();
          if (now - this.lastPasteAt < 250) return;
          this.lastPasteAt = now;

          if (!this.settings.enabled) return;
          if (evt.defaultPrevented) return;
          if (!(view instanceof MarkdownView)) return;

          const info = findFenceInfo(editor, editor.getCursor());
          if (!info.inside || !isPythonLang(info.lang)) return;

          const text = evt.clipboardData?.getData('text/plain');
          if (!text) return;

          evt.preventDefault();

          if (this.settings.scope === 'snippet') {
            try {
              const formattedSnippet = await this.formatText(text);
              editor.replaceSelection(formattedSnippet);
            } catch {
              editor.replaceSelection(text);
            }
            return;
          }

          const merged = mergePasteIntoBlock(editor, info, text);
          try {
            const formatted = await this.formatText(merged);
            replaceBlock(editor, info, formatted);
          } catch (e) {
            console.error('Python Paste Formatter: formatter failed, pasting unformatted.', e);
            editor.replaceSelection(text);
          }
        } catch (e) {
          console.error(e);
        }
      })
    );
  }

  async formatWholeBlock(editor: Editor, info: FenceInfo): Promise<string> {
    const merged = getBlockText(editor, info);
    return await this.formatText(merged);
  }

  async formatText(code: string): Promise<string> {
    const engine = this.settings.engine;
    if (engine === 'ruff') {
      return await runFormatter(this.settings.ruffPath, ['format', '--stdin-filename', 'pasted.py', '--line-length', String(this.settings.lineLength), '-'], code);
    } else {
      return await runFormatter(this.settings.blackPath, ['-q', '--stdin-filename', 'pasted.py', '--line-length', String(this.settings.lineLength), '-'], code);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

async function runFormatter(cmd: string, args: string[], input: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let out = '';
    let err = '';
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out || input);
      } else {
        reject(new Error(err || `Formatter exited with code ${code}`));
      }
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

interface FenceInfo {
  inside: boolean;
  lang: string | null;
  startLine: number; // line index of opening ```
  endLine: number;   // line index of closing ```
}

function isPythonLang(lang: string | null): boolean {
  if (!lang) return false;
  const l = lang.toLowerCase();
  return l === 'python' || l === 'py' || l === 'python3' || l === 'py3';
}

function extractFenceLang(fenceLine: string): string | null {
  const m = fenceLine.trim().match(/^`{3,}\s*([^\s`{]+)?/);
  if (!m) return null;
  return m[1] ?? null;
}

function findFenceInfo(editor: Editor, pos: EditorPosition): FenceInfo {
  const total = editor.lineCount();
  let open = -1;
  for (let i = pos.line; i >= 0; i--) {
    const line = editor.getLine(i);
    if (line.startsWith('```')) { open = i; break; }
  }
  if (open === -1) return { inside: false, lang: null, startLine: -1, endLine: -1 };

  let close = -1;
  for (let j = open + 1; j < total; j++) {
    const line = editor.getLine(j);
    if (line.startsWith('```')) { close = j; break; }
  }
  if (close === -1) return { inside: false, lang: null, startLine: -1, endLine: -1 };

  const inside = pos.line > open && pos.line < close;
  const lang = extractFenceLang(editor.getLine(open));
  return { inside, lang, startLine: open, endLine: close };
}

function getBlockText(editor: Editor, info: FenceInfo): string {
  const from: EditorPosition = { line: info.startLine + 1, ch: 0 };
  const to: EditorPosition = { line: info.endLine, ch: 0 };
  return editor.getRange(from, to);
}

function mergePasteIntoBlock(editor: Editor, info: FenceInfo, pasted: string): string {
  const blockStart: EditorPosition = { line: info.startLine + 1, ch: 0 };
  const blockEnd: EditorPosition = { line: info.endLine, ch: 0 };

  const selFrom = editor.getCursor('from');
  const selTo = editor.getCursor('to');

  const safeFrom: EditorPosition = (selFrom.line <= info.startLine) ? blockStart : selFrom;
  const safeTo: EditorPosition = (selTo.line >= info.endLine) ? blockEnd : selTo;

  const left = editor.getRange(blockStart, safeFrom);
  const right = editor.getRange(safeTo, blockEnd);
  return left + pasted + right;
}

function replaceBlock(editor: Editor, info: FenceInfo, newCode: string) {
  const from: EditorPosition = { line: info.startLine + 1, ch: 0 };
  const to: EditorPosition = { line: info.endLine, ch: 0 };
  editor.replaceRange(newCode, from, to);
}

class PythonPasteFormatterSettingTab extends PluginSettingTab {
  plugin: PythonPasteFormatterPlugin;

  constructor(app: App, plugin: PythonPasteFormatterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Python Paste Formatter' });

    new Setting(containerEl)
      .setName('Enable')
      .setDesc('Auto-format on paste inside ```python fences.')
      .addToggle(t => t
        .setValue(this.plugin.settings.enabled)
        .onChange(async (v) => { this.plugin.settings.enabled = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Formatter engine')
      .setDesc('Choose Ruff (recommended) or Black. Requires a local executable on PATH or specify a full path.')
      .addDropdown(d => d
        .addOptions({ 'ruff': 'Ruff', 'black': 'Black' })
        .setValue(this.plugin.settings.engine)
        .onChange(async (v: Engine) => { this.plugin.settings.engine = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Ruff path')
      .setDesc('Executable to run for Ruff (e.g., ruff)')
      .addText(t => t
        .setValue(this.plugin.settings.ruffPath)
        .onChange(async (v) => { this.plugin.settings.ruffPath = v.trim() || 'ruff'; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Black path')
      .setDesc('Executable to run for Black (e.g., black)')
      .addText(t => t
        .setValue(this.plugin.settings.blackPath)
        .onChange(async (v) => { this.plugin.settings.blackPath = v.trim() || 'black'; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Line length')
      .setDesc('Passed to the formatter. Default 88.')
      .addText(t => t
        .setPlaceholder('88')
        .setValue(String(this.plugin.settings.lineLength))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n > 0) {
            this.plugin.settings.lineLength = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Scope')
      .setDesc('Format the whole fenced block (safer) or just the pasted snippet (may fail for partial code).')
      .addDropdown(d => d
        .addOptions({ 'block': 'Whole block (recommended)', 'snippet': 'Only pasted snippet' })
        .setValue(this.plugin.settings.scope)
        .onChange(async (v: 'block' | 'snippet') => { this.plugin.settings.scope = v; await this.plugin.saveSettings(); }));
  }
}
