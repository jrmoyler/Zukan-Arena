import { DEFAULT_PROFILE, profile } from '../core/Profile';
import { DEFAULT_SETTINGS, settings, type Settings } from '../core/Settings';
import { ELEMENT_ADVANTAGE, ELEMENT_LABEL } from '../data/kits';
import { PICKUP_HEAL } from '../simulation/CombatSimulation';
import type { ElementKind } from '../types';
import { el } from './dom';
import { elementIcon, ICONS } from './icons';

/** Modal panel builders: settings, how-to-play and the pause menu. */

type Tab = 'audio' | 'video' | 'gameplay' | 'access' | 'controls';

const TABS: Record<Tab, string> = {
  audio: 'Audio',
  video: 'Video',
  gameplay: 'Gameplay',
  access: 'Accessibility',
  controls: 'Controls',
};

function slider(key: keyof Settings, label: string, value: number, min = 0, max = 1, step = 0.05): string {
  const fill = ((value - min) / (max - min)) * 100;
  return `<label class="setting"><span>${label}</span><input type="range" data-setting="${key}" min="${min}" max="${max}" step="${step}" value="${value}" style="--fill:${fill}%" /><output>${Math.round(value * 100)}%</output></label>`;
}

function toggle(key: keyof Settings, label: string, value: boolean, hint = ''): string {
  return `<div class="setting"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><button class="switch" role="switch" aria-checked="${value}" data-toggle="${key}" aria-label="${label}"></button></div>`;
}

function choice<T extends string>(key: keyof Settings, label: string, value: T, options: Record<T, string>): string {
  return `<div class="setting"><span>${label}</span><div class="segmented">${(Object.keys(options) as T[]).map((option) => `<button class="${option === value ? 'is-active' : ''}" data-choice="${key}" data-value="${option}">${options[option]}</button>`).join('')}</div></div>`;
}

export function buildSettingsPanel(onClose: () => void, onResetProgress: () => void): HTMLElement {
  const panel = el('div', 'modal glass settings-modal');
  let tab: Tab = 'audio';
  const render = () => {
    const s = settings.get();
    let body = '';
    switch (tab) {
      case 'audio':
        body = slider('masterVolume', 'Master', s.masterVolume) + slider('musicVolume', 'Music', s.musicVolume) + slider('sfxVolume', 'Effects', s.sfxVolume);
        break;
      case 'video':
        body = choice('quality', 'Graphics quality', s.quality, { auto: 'Auto', high: 'High', medium: 'Medium', low: 'Low' })
          + `<p class="setting-hint">Auto picks a tier from your device and lowers internal resolution if frames drop. High enables soft shadows, bloom and dense particles.</p>`
          + toggle('showFps', 'Show frame rate', s.showFps);
        break;
      case 'gameplay':
        body = choice('difficulty', 'Default difficulty', s.difficulty, { novice: 'Novice', adept: 'Adept', master: 'Master' })
          + toggle('aimAssist', 'Aim assist', s.aimAssist, 'Gamepad and touch snap toward the nearest foe')
          + toggle('damageNumbers', 'Damage numbers', s.damageNumbers)
          + slider('screenShake', 'Screen shake', s.screenShake);
        break;
      case 'access':
        body = choice('motion', 'Motion', s.motion, { system: 'System', reduced: 'Reduced', full: 'Full' })
          + toggle('colorSafeTeams', 'Colour-safe team colours', s.colorSafeTeams, 'Blue vs orange instead of cyan vs rose')
          + slider('hudScale', 'HUD scale', s.hudScale, 0.8, 1.3, 0.05);
        break;
      case 'controls':
        body = `
          <table class="controls-table">
            <thead><tr><th>Action</th><th>Keyboard & mouse</th><th>Gamepad</th></tr></thead>
            <tbody>
              <tr><td>Move</td><td><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> / arrows</td><td>Left stick</td></tr>
              <tr><td>Aim</td><td>Mouse</td><td>Right stick (or aim assist)</td></tr>
              <tr><td>Basic bolt</td><td>Hold left click or <kbd>J</kbd></td><td><kbd>RT</kbd></td></tr>
              <tr><td>Signature</td><td>Right click or <kbd>Q</kbd></td><td><kbd>X</kbd> / <kbd>LB</kbd></td></tr>
              <tr><td>Dash</td><td><kbd>Space</kbd> / <kbd>Shift</kbd></td><td><kbd>A</kbd> / <kbd>LT</kbd></td></tr>
              <tr><td>Ultimate</td><td><kbd>E</kbd> / <kbd>R</kbd> / middle click</td><td><kbd>Y</kbd> / <kbd>RB</kbd></td></tr>
              <tr><td>Pause</td><td><kbd>Esc</kbd> / <kbd>P</kbd></td><td><kbd>Start</kbd></td></tr>
            </tbody>
          </table>
          <p class="setting-hint">Touch: drag the left half to move, hold the gold button to fire, hold and drag the signature or ultimate button to aim, release to cast.</p>`;
        break;
    }
    panel.innerHTML = `
      <div class="modal-title-row"><h2>Settings</h2><button class="icon-button" data-close aria-label="Close">${ICONS.close}</button></div>
      <div class="tabs" role="tablist">${(Object.keys(TABS) as Tab[]).map((key) => `<button role="tab" class="tab${key === tab ? ' is-active' : ''}" aria-selected="${key === tab}" data-tab="${key}">${TABS[key]}</button>`).join('')}</div>
      <div class="settings-body">${body}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" data-reset-settings>Restore defaults</button>
        ${tab === 'gameplay' ? '<button class="btn btn-ghost btn-sm danger" data-reset-progress>Reset progress</button>' : ''}
        <span class="spacer"></span>
        <button class="btn btn-primary" data-close data-autofocus>Done</button>
      </div>`;
  };
  render();

  panel.addEventListener('input', (event) => {
    const input = event.target as HTMLInputElement;
    const key = input.dataset.setting as keyof Settings | undefined;
    if (!key) return;
    const value = Number(input.value);
    settings.update({ [key]: value } as Partial<Settings>);
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
    const output = input.nextElementSibling;
    if (output) output.textContent = `${Math.round(value * 100)}%`;
  });
  panel.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    if (target.dataset.tab) {
      tab = target.dataset.tab as Tab;
      render();
      panel.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
    } else if (target.dataset.toggle) {
      const key = target.dataset.toggle as keyof Settings;
      const next = !settings.get()[key];
      settings.update({ [key]: next } as Partial<Settings>);
      target.setAttribute('aria-checked', String(next));
    } else if (target.dataset.choice) {
      settings.update({ [target.dataset.choice]: target.dataset.value } as Partial<Settings>);
      render();
    } else if (target.hasAttribute('data-reset-settings')) {
      settings.reset(DEFAULT_SETTINGS);
      render();
    } else if (target.hasAttribute('data-reset-progress')) {
      if (target.dataset.confirm === 'yes') {
        profile.reset(DEFAULT_PROFILE);
        onResetProgress();
      } else {
        target.dataset.confirm = 'yes';
        target.textContent = 'Tap again to erase all progress';
      }
    } else if (target.hasAttribute('data-close')) {
      onClose();
    }
  });
  return panel;
}

export function buildHowToPlay(onClose: () => void): HTMLElement {
  const panel = el('div', 'modal glass how-modal');
  const triangle = (elements: ElementKind[]) => `
    <div class="res-triangle">${elements.map((element) => `<span class="el-${element}">${elementIcon(element)}<small>${ELEMENT_LABEL[element]}</small></span><i>›</i>`).join('')}<span class="el-${elements[0]}">${elementIcon(elements[0]!)}</span></div>`;
  panel.innerHTML = `
    <div class="modal-title-row"><h2>How to play</h2><button class="icon-button" data-close aria-label="Close">${ICONS.close}</button></div>
    <div class="how-grid">
      <section><span class="how-icon">${ICONS.swords}</span><h3>Win the round</h3><p>Knock out the entire Rift squad, or hold more total vitality when the clock expires. First to two rounds takes the match.</p></section>
      <section><span class="how-icon">${ICONS.basic}</span><h3>Bolts</h3><p>Hold attack to fire your role's bolt toward your aim. Builders hit hard, Creators fire fast, Strategists pierce.</p></section>
      <section><span class="how-icon">${ICONS.target}</span><h3>Signatures are telegraphed</h3><p>Every signature and ultimate marks the ground before it lands. Red circles are the Rift's — step out or dash through them.</p></section>
      <section><span class="how-icon">${ICONS.dash}</span><h3>Dash</h3><p>A quick burst with brief invulnerability. Time it as a red circle fills to take no damage at all.</p></section>
      <section><span class="how-icon">${ICONS.ultimate}</span><h3>Ultimate</h3><p>Dealing and taking damage charges it. When the star glows, unleash an amplified signature with a powerful effect.</p></section>
      <section><span class="how-icon">${ICONS.glimmer}</span><h3>Resonance Bloom</h3><p>A golden crystal surfaces at the centre. Claim it to heal ${PICKUP_HEAL} vitality and charge your ultimate.</p></section>
    </div>
    <div class="how-resonance">
      <h3>Elemental resonance</h3>
      <p>Attacks against the element yours overpowers deal <strong>25% more</strong>; against the element that overpowers yours, <strong>20% less</strong>.</p>
      <div class="triangles">${triangle(['earth', ELEMENT_ADVANTAGE.earth, ELEMENT_ADVANTAGE[ELEMENT_ADVANTAGE.earth]])}${triangle(['gale', ELEMENT_ADVANTAGE.gale, ELEMENT_ADVANTAGE[ELEMENT_ADVANTAGE.gale]])}</div>
    </div>
    <div class="modal-actions"><span class="spacer"></span><button class="btn btn-primary" data-close data-autofocus>Got it</button></div>`;
  panel.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('[data-close]')) onClose();
  });
  return panel;
}

export interface PauseHandlers {
  resume: () => void;
  restart: () => void;
  settings: () => void;
  howTo: () => void;
  quit: () => void;
  training: boolean;
}

export function buildPauseMenu(handlers: PauseHandlers): HTMLElement {
  const panel = el('div', 'modal glass pause-modal');
  panel.innerHTML = `
    <p class="eyebrow">${handlers.training ? 'Training paused' : 'Match paused'}</p>
    <h2>Catch your breath</h2>
    <div class="menu-list">
      <button class="btn btn-primary" data-pause="resume" data-autofocus>${ICONS.play}Resume</button>
      ${handlers.training ? '' : `<button class="btn" data-pause="restart">${ICONS.restart}Restart match</button>`}
      <button class="btn" data-pause="settings">${ICONS.gear}Settings</button>
      <button class="btn" data-pause="howTo">${ICONS.question}How to play</button>
      <button class="btn btn-ghost" data-pause="quit">${ICONS.home}${handlers.training ? 'Leave training' : 'Forfeit & quit'}</button>
    </div>`;
  panel.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-pause]');
    if (!target) return;
    const action = target.dataset.pause as keyof Omit<PauseHandlers, 'training'>;
    if (action === 'quit' && !handlers.training && target.dataset.confirm !== 'yes') {
      target.dataset.confirm = 'yes';
      target.innerHTML = `${ICONS.home}Confirm forfeit`;
      return;
    }
    handlers[action]();
  });
  return panel;
}
