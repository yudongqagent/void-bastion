// DOM layer for VOID BASTION.
//
// The canvas never draws chrome and this file never touches the simulation
// beyond reading state and calling buy/use methods. Keeping that line clean is
// what lets the game run at 60fps while the UI updates at 10Hz — a full DOM
// refresh every frame would be pure waste, since a cost label changing 60 times
// a second is invisible.

import {
  UPGRADES, LAB, ABILITIES, upgradeCost, upgradeBulkCost, affordableLevels,
  upgradeMaxLevel, labCost, labMult, coresForRun, startingWave, deriveStats,
  speedOptions, fmt, isBossWave, masteryLabel, masteryTier, MASTERY,
  DIFFICULTIES, difficulty, unlockedDifficulty, UNLOCK_LEVEL,
} from '../game/balance.js';
import { levelOf, phaseOf, PHASES_PER_LEVEL, STEPS_PER_LEVEL } from '../game/levels.js';

const ABILITY_GLYPH = {
  overdrive: '▶▶', nova: '◎', aegis: '✦',
  singularity: '●', lance: '╱',
};

/** Renders a stat value the way its upgrade wants to be read. */
function statText(key, stats) {
  const u = UPGRADES[key];
  const v = {
    damage: stats.damage, fireRate: stats.fireRate, critChance: stats.critChance,
    critMult: stats.critMult, multishot: stats.shots,
    range: stats.range, maxHull: stats.maxHull, regen: stats.regen,
    shieldMax: stats.maxShield, shieldRegen: stats.shieldRegen, armor: stats.armor,
    thorns: stats.thorns, coinBonus: stats.coinMult, magnet: stats.magnet,
    drones: stats.drones, lifesteal: stats.lifesteal,
    // Weapon systems. Without these the lookup returned undefined and fmt()
    // rendered every one of them as "∞".
    laser: stats.laserDps, missiles: stats.missileDmg,
    flak: stats.flakDmg, arc: stats.arcDmg, interest: stats.interest,
  }[key];
  if (v == null || !isFinite(v)) return '—';
  switch (u.fmt) {
    case 'pct':      return (v * 100).toFixed(1) + '%';
    case 'pctBonus': return '×' + v.toFixed(2);
    case 'mult':     return '×' + v.toFixed(2);
    case 'rate':     return fmt(v) + '/s';
    case 'int':      return String(Math.round(v));
    default:         return fmt(v);
  }
}

export class UI {
  constructor(game, state, synth) {
    this.game = game;
    this.state = state;
    this.synth = synth;
    this.tab = 'offense';
    this.qty = 1;
    this.rows = new Map();       // upgrade key -> {el, cost, lv, val, qty}
    this.abilityEls = new Map();
    this.openModal = null;

    this.$ = (id) => document.getElementById(id);
    this.cache();
    this.bind();
    this.buildUpgradeRows();
    this.buildAbilityBar();
    this.syncInsets();
  }

  isDesktop() {
    return window.matchMedia('(min-width: 860px) and (orientation: landscape)').matches;
  }

  cache() {
    for (const id of ['waveNum', 'coinNum', 'coreNum', 'bossTag', 'upgradeList', 'drawer',
      'abilities', 'modalRoot', 'toasts',
      'speedBtn', 'soundBtn', 'labList', 'abilityShop', 'labCores', 'menuStats',
      'zoneName', 'phaseDots', 'home', 'diffList', 'homeStats']) {
      this[id] = this.$(id);
    }
  }

  bind() {
    const click = (el, fn) => el && el.addEventListener('click', (e) => {
      this.synth.click();
      fn(e);
    });

    this.$('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      this.synth.click();
      this.tab = b.dataset.tab;
      for (const t of this.$('tabs').children) t.classList.toggle('active', t === b);
      this.buildUpgradeRows();
    });

    document.querySelector('.buy-mode').addEventListener('click', (e) => {
      const b = e.target.closest('.qty');
      if (!b) return;
      this.synth.click();
      this.qty = b.dataset.qty === 'max' ? 'max' : Number(b.dataset.qty);
      for (const q of b.parentElement.querySelectorAll('.qty')) q.classList.toggle('active', q === b);
      this.refreshUpgrades();
    });

    this.upgradeList.addEventListener('click', (e) => {
      const row = e.target.closest('.up');
      if (row) this.buy(row.dataset.key);
    });

    click(this.speedBtn, () => this.cycleSpeed());
    click(this.soundBtn, () => this.toggleSound());
    click(this.$('menuBtn'), () => this.showModal('modalMenu'));

    this.modalRoot.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) { this.synth.click(); this.hideModal(); }
    });

    click(this.$('menuLabBtn'), () => this.showModal('modalLab'));
    click(this.$('menuAscendBtn'), () => this.showAscend());
    click(this.$('menuHelpBtn'), () => this.showModal('modalHelp'));
    click(this.$('menuHomeBtn'), () => { this.forceHideModal(); this.showHome(); });
    click(this.$('homeHelpBtn'), () => this.showModal('modalHelp'));
    click(this.$('launchBtn'), () => this.launch());
    this.diffList.addEventListener('click', (e) => {
      const row = e.target.closest('.diff');
      if (!row || row.classList.contains('locked')) return;
      this.synth.click();
      this.pendingDiff = Number(row.dataset.i);
      this.buildHome();
    });
    click(this.$('overLabBtn'), () => this.showModal('modalLab', { returnTo: 'modalOver' }));
    click(this.$('wipeBtn'), () => this.confirmWipe());

    this.labList.addEventListener('click', (e) => {
      const row = e.target.closest('.up');
      if (row) this.buyLab(row.dataset.key);
    });
    this.abilityShop.addEventListener('click', (e) => {
      const row = e.target.closest('.up');
      if (row) this.buyAbility(row.dataset.key);
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k >= '1' && k <= '5') {
        const key = Object.keys(ABILITIES)[Number(k) - 1];
        if (key) this.game.useAbility(key);
      } else if (k === 'escape') {
        if (this.openModal) this.hideModal();
      } else if (k === ' ') {
        e.preventDefault();
        this.cycleSpeed();
      }
    });

    window.addEventListener('resize', () => this.syncInsets());
  }

  /**
   * Keep the battlefield centred in the part of the screen the UI isn't using.
   * The upgrade panel is permanent — a bottom sheet on phones, a right-hand
   * column on desktop — so the world is always offset around it.
   */
  syncInsets() {
    const px = (el) => (el ? el.getBoundingClientRect().height : 0);
    const top = px(document.getElementById('hud'));
    if (this.isDesktop()) {
      this.game.setInsets(top, this.drawer.getBoundingClientRect().width || 330,
        px(this.abilities) + 34);
    } else {
      this.game.setInsets(top, 0,
        this.drawer.getBoundingClientRect().height + px(this.abilities) + 14);
    }
  }

  // --- upgrades ---------------------------------------------------------------

  buildUpgradeRows() {
    this.rows.clear();
    const frag = document.createDocumentFragment();
    for (const [key, u] of Object.entries(UPGRADES)) {
      if (u.tab !== this.tab) continue;
      const el = document.createElement('div');
      el.className = 'up';
      el.dataset.key = key;
      // One markup shape for both layouts. On phones this stacks into a compact
      // two-per-row card and the description is hidden by CSS; on desktop the
      // same nodes lay out as a wide row with the description showing.
      el.title = `${u.name} — ${u.desc}`;
      // Weapon systems carry a colour pip matching the light they make on
      // screen, so "which upgrade did that?" is answerable without reading.
      const pip = u.tint ? `<i class="w-pip w-${u.tint}"></i>` : '';
      el.innerHTML = `
        <div class="up-main">
          <div class="up-head">
            <span class="up-name">${pip}${u.name}</span>
            <span class="up-lv">Lv 0</span>
          </div>
          <div class="up-desc">${u.desc}</div>
          <div class="up-val"></div>
          <div class="up-mastery"></div>
        </div>
        <div class="up-buy">
          <span class="up-cost">0</span>
          <span class="up-qty"></span>
        </div>`;
      frag.appendChild(el);
      this.rows.set(key, {
        el,
        lv: el.querySelector('.up-lv'),
        val: el.querySelector('.up-val'),
        cost: el.querySelector('.up-cost'),
        qty: el.querySelector('.up-qty'),
        mastery: el.querySelector('.up-mastery'),
      });
    }
    this.upgradeList.replaceChildren(frag);
    this.refreshUpgrades();
  }

  /**
   * The stat this upgrade would read at `extra` more levels.
   *
   * Deriving the whole stat block rather than adding `add * n` is deliberate:
   * Lab multipliers, ascension bonuses and caps all fold in, so the preview can
   * never disagree with what the player actually gets.
   */
  previewStat(key, extra) {
    const up = { ...this.state.run.upgrades };
    up[key] = (up[key] || 0) + extra;
    return statText(key, deriveStats(up, this.state.meta.lab, this.state.meta.prestiges));
  }

  /** How many levels a click would buy, and what that costs. */
  purchasePlan(key) {
    const { run } = this.state;
    const lvl = run.upgrades[key] || 0;
    const max = upgradeMaxLevel(key);
    if (lvl >= max) return null;
    let n = this.qty === 'max'
      ? affordableLevels(key, lvl, run.coins)
      : Math.min(this.qty, max - lvl);
    if (this.qty === 'max' && n === 0) n = 1;   // show the next single cost
    n = Math.max(1, n);
    return { n, cost: upgradeBulkCost(key, lvl, n), lvl, max };
  }

  refreshUpgrades() {
    const { run } = this.state;
    const stats = this.game.stats;
    for (const [key, r] of this.rows) {
      const lvl = run.upgrades[key] || 0;
      const plan = this.purchasePlan(key);
      const maxed = plan === null;
      r.lv.textContent = maxed ? 'MAX' : 'Lv ' + lvl;
      r.lv.classList.toggle('is-max', maxed);
      if (maxed) {
        r.val.innerHTML =
          `<span class="v-label">${UPGRADES[key].label}</span>` +
          `<span class="v-next">${statText(key, stats)}</span>`;
      } else {
        // "576 → 632" reads instantly; a bare current value does not tell you
        // whether the next level is worth the coins.
        // The flavour name ("Plasma Yield") says nothing about what the number
        // measures, and the description is hidden in the compact card — so the
        // value line names the property itself.
        r.val.innerHTML =
          `<span class="v-label">${UPGRADES[key].label}</span>` +
          `<span class="v-now">${statText(key, stats)}</span>` +
          `<span class="v-arrow">→</span>` +
          `<span class="v-next">${this.previewStat(key, plan.n)}</span>`;
      }
      // Weapon systems earn qualitative upgrades at set levels; showing the
      // current behaviour and the next threshold is what makes going deep on
      // one system a decision rather than a guess.
      if (r.mastery) {
        const m = masteryLabel(key, lvl);
        if (m) {
          const next = MASTERY[m.tier + 1];
          r.mastery.innerHTML =
            `<b>T${m.tier}</b> ${m.text}` +
            (next ? `<em> · T${m.tier + 1} at Lv ${next.at}</em>` : '');
          r.mastery.hidden = false;
        } else {
          r.mastery.hidden = true;
        }
      }

      if (maxed) {
        r.cost.textContent = '—';
        r.qty.textContent = '';
        r.el.className = 'up maxed';
      } else {
        const afford = run.coins >= plan.cost;
        r.cost.textContent = fmt(plan.cost);
        r.qty.textContent = plan.n > 1 ? `×${plan.n}` : '';
        r.el.className = 'up ' + (afford ? 'afford' : 'poor');
      }
    }
  }

  buy(key) {
    const { run } = this.state;
    const plan = this.purchasePlan(key);
    if (!plan) return;
    if (run.coins < plan.cost) { this.synth.denied(); return; }
    run.coins -= plan.cost;
    run.upgrades[key] = plan.lvl + plan.n;
    this.game.markStatsDirty();
    this.state.markDirty();
    this.synth.upgrade();

    // Keep hull/shield proportional so buying max-hull mid-fight is a real heal
    // rather than a bar that silently gets emptier.
    const s = this.game.stats;
    if (key === 'maxHull') run.hull = Math.min(s.maxHull, run.hull + UPGRADES.maxHull.add * plan.n);
    if (key === 'shieldMax') run.shield = Math.min(s.maxShield, run.shield + UPGRADES.shieldMax.add * plan.n);

    this.refreshUpgrades();
    this.game.addFloater(this.game.cx, this.game.cy + 46,
      UPGRADES[key].name.toUpperCase(), [0.4, 1.4, 1.6], 0.9);
  }

  // --- lab --------------------------------------------------------------------

  buildLab() {
    const { meta } = this.state;
    this.labCores.textContent = fmt(meta.cores);
    const frag = document.createDocumentFragment();
    for (const [key, l] of Object.entries(LAB)) {
      const lvl = meta.lab[key] || 0;
      const atMax = l.maxLevel != null && lvl >= l.maxLevel;
      const cost = labCost(key, lvl);
      const afford = meta.cores >= cost;

      // Every track states its effect the same way the upgrade cards do:
      // what it is now, and what one more level makes it.
      let now, next;
      if (key === 'labSpeed') {
        now = speedOptions(lvl).slice(-1)[0] + '×';
        next = speedOptions(lvl + 1).slice(-1)[0] + '×';
      } else if (key === 'labStartCash') {
        now = fmt(l.flatBase * (Math.pow(l.mul, lvl) - 1));
        next = fmt(l.flatBase * (Math.pow(l.mul, lvl + 1) - 1));
      } else {
        now = '×' + labMult(key, lvl).toFixed(2);
        next = '×' + labMult(key, lvl + 1).toFixed(2);
      }

      const el = document.createElement('div');
      el.className = 'up lab ' + (atMax ? 'maxed' : afford ? 'afford' : 'poor');
      el.dataset.key = key;
      el.title = `${l.name} — ${l.desc}`;
      el.innerHTML = `
        <div class="up-main">
          <div class="up-head">
            <span class="up-name">${l.name}</span>
            <span class="up-lv${atMax ? ' is-max' : ''}">${atMax ? 'MAX' : 'Lv ' + lvl}</span>
          </div>
          <div class="up-desc">${l.desc}</div>
          <div class="up-val"><span class="v-label">${l.label}</span>${atMax
            ? `<span class="v-next">${now}</span>`
            : `<span class="v-now">${now}</span><span class="v-arrow">→</span><span class="v-next">${next}</span>`}</div>
        </div>
        <div class="up-buy">
          <span class="up-cost">${atMax ? '—' : fmt(cost)}</span>
          <span class="up-qty">${atMax ? '' : 'cores'}</span>
        </div>`;
      frag.appendChild(el);
    }
    this.labList.replaceChildren(frag);

    const afrag = document.createDocumentFragment();
    for (const [key, a] of Object.entries(ABILITIES)) {
      const owned = this.state.abilityUnlocked(key);
      const afford = meta.cores >= a.cost;
      const el = document.createElement('div');
      el.className = 'up lab ability-card ' + (owned ? 'maxed' : afford ? 'afford' : 'poor');
      el.dataset.key = key;
      el.title = `${a.name} — ${a.desc}`;
      el.innerHTML = `
        <div class="up-main">
          <div class="up-head">
            <span class="up-name"><b class="ab-mark">${ABILITY_GLYPH[key]}</b> ${a.name}</span>
            ${owned ? '<span class="up-lv is-max">OWNED</span>' : ''}
          </div>
          <div class="up-val">${a.desc}</div>
          <div class="up-sub">${a.cd}s cooldown</div>
        </div>
        <div class="up-buy">
          <span class="up-cost">${owned ? '—' : fmt(a.cost)}</span>
          <span class="up-qty">${owned ? '' : 'cores'}</span>
        </div>`;
      afrag.appendChild(el);
    }
    this.abilityShop.replaceChildren(afrag);
  }

  buyLab(key) {
    const { meta } = this.state;
    const lvl = meta.lab[key] || 0;
    const l = LAB[key];
    if (l.maxLevel != null && lvl >= l.maxLevel) return;
    const cost = labCost(key, lvl);
    if (meta.cores < cost) { this.synth.denied(); return; }
    meta.cores -= cost;
    meta.lab[key] = lvl + 1;
    this.game.markStatsDirty();
    this.state.save();
    this.synth.upgrade();
    this.buildLab();
    this.toast(`${l.name} → Lv ${lvl + 1}`, 'violet');
    if (key === 'labSpeed') this.updateSpeedButton();
  }

  buyAbility(key) {
    const { meta } = this.state;
    if (this.state.abilityUnlocked(key)) return;
    const a = ABILITIES[key];
    if (meta.cores < a.cost) { this.synth.denied(); return; }
    meta.cores -= a.cost;
    meta.abilities[key] = true;
    this.state.save();
    this.synth.prestige();
    this.buildLab();
    this.buildAbilityBar();
    this.toast(`${a.name} ONLINE`, 'violet');
  }

  // --- abilities ---------------------------------------------------------------

  buildAbilityBar() {
    this.abilityEls.clear();
    const frag = document.createDocumentFragment();
    for (const key of Object.keys(ABILITIES)) {
      if (!this.state.abilityUnlocked(key)) continue;
      const a = ABILITIES[key];
      const btn = document.createElement('button');
      btn.className = 'ability';
      btn.title = `${a.name} — ${a.desc}`;
      btn.innerHTML = `
        <span class="ab-glyph">${ABILITY_GLYPH[key]}</span>
        <span class="ab-name">${a.name.split(' ')[0].toUpperCase()}</span>
        <span class="ab-cd" hidden></span>`;
      btn.addEventListener('click', () => this.game.useAbility(key));
      frag.appendChild(btn);
      this.abilityEls.set(key, { btn, cd: btn.querySelector('.ab-cd') });
    }
    this.abilities.replaceChildren(frag);
  }

  refreshAbilities() {
    const { run } = this.state;
    for (const [key, el] of this.abilityEls) {
      const left = run.cooldowns[key] || 0;
      const active = (this.game.buffs[key] || 0) > 0;
      if (left > 0) {
        el.cd.hidden = false;
        el.cd.textContent = left > 1 ? Math.ceil(left) : left.toFixed(1);
      } else {
        el.cd.hidden = true;
      }
      el.btn.classList.toggle('ready', left <= 0);
      el.btn.classList.toggle('active', active);
    }
  }

  // --- per-frame-ish refresh -----------------------------------------------------

  refresh() {
    const { run, meta } = this.state;
    const s = this.game.stats;

    // The player counts levels; `run.wave` survives underneath as the
    // difficulty index every balance formula is tuned against.
    const level = levelOf(run.wave);
    const phase = phaseOf(run.wave);
    if (this._level !== level || this._phase !== phase) {
      this._level = level; this._phase = phase;
      this.waveNum.textContent = level;
      this.renderPhaseDots(phase);
    }
    this.bossTag.hidden = !isBossWave(run.wave);
    this.coinNum.textContent = fmt(run.coins);
    this.coreNum.textContent = fmt(meta.cores);

    this.refreshAbilities();
    this.refreshUpgrades();
  }


  // --- home screen ------------------------------------------------------

  showHome() {
    this.pendingDiff = this.state.meta.difficulty || 0;
    this.buildHome();
    this.home.hidden = false;
    this.game.paused = true;
  }

  buildHome() {
    const { meta } = this.state;
    const unlocked = unlockedDifficulty(meta.bestByDiff);
    const frag = document.createDocumentFragment();

    DIFFICULTIES.forEach((d, i) => {
      const locked = i > unlocked;
      const best = (meta.bestByDiff && meta.bestByDiff[i]) || 0;
      const el = document.createElement('div');
      el.className = 'diff' + (i === this.pendingDiff ? ' sel' : '') + (locked ? ' locked' : '');
      el.dataset.i = i;
      const prev = DIFFICULTIES[i - 1];
      el.innerHTML = `
        <div>
          <div class="diff-name">${d.name}</div>
          <div class="diff-blurb">${d.blurb}</div>
          ${locked
            ? `<div class="diff-req">Reach level ${UNLOCK_LEVEL} on ${prev.name} to unlock</div>`
            : `<div class="diff-meta">enemy hull ×${d.hp.toFixed(1)} · damage ×${d.dmg.toFixed(2)}${
                best ? ` · best level ${best}` : ''}</div>`}
        </div>
        ${locked
          ? '<div class="diff-lock">&#128274;</div>'
          : `<div class="diff-core">×${d.cores.toFixed(1)}<span>CORES</span></div>`}`;
      frag.appendChild(el);
    });
    this.diffList.replaceChildren(frag);

    this.homeStats.innerHTML =
      `<div>CORES <b>${fmt(meta.cores)}</b></div>` +
      `<div>ASCENSIONS <b>${meta.prestiges}</b></div>` +
      `<div>BEST <b>${(meta.bestByDiff && meta.bestByDiff[this.pendingDiff]) || 0}</b></div>`;
  }

  /**
   * Commit the chosen difficulty and start flying.
   *
   * Changing tier restarts the run — enemy scaling is baked in when a wave is
   * built, so continuing mid-run on a new tier would leave the current level
   * mismatched against the one that follows it.
   */
  launch() {
    const { meta } = this.state;
    const next = Math.min(this.pendingDiff, unlockedDifficulty(meta.bestByDiff));
    const changed = next !== (meta.difficulty || 0);
    meta.difficulty = next;
    meta.seenHome = true;
    this.home.hidden = true;
    this.state.save();
    if (changed && this.onDifficultyChange) this.onDifficultyChange();
    this.game.paused = false;
    this.toast(`${difficulty(next).name} — CORES ×${difficulty(next).cores.toFixed(1)}`, 'violet', true);
  }

  /** Four phase pips plus a wider boss pip, filled as the level progresses. */
  renderPhaseDots(phase) {
    if (!this.phaseDots) return;
    let html = '';
    for (let i = 1; i <= STEPS_PER_LEVEL; i++) {
      const boss = i === STEPS_PER_LEVEL;
      const cls = (i < phase ? 'done' : i === phase ? 'done' : '') + (boss ? ' boss' : '');
      html += `<i class="${cls.trim()}"></i>`;
    }
    this.phaseDots.innerHTML = html;
  }

  /** Announce a new level: where you are, what is waiting, what changed. */
  showLevelCard(d) {
    const el = document.createElement('div');
    el.className = 'level-card';
    el.innerHTML =
      `<div class="lc-lvl">LEVEL ${d.level}</div>` +
      `<div class="lc-name">${d.name}</div>` +
      `<div class="lc-boss">${d.boss}</div>` +
      `<div class="lc-tell">${d.tell}</div>` +
      (d.refit ? `<div class="lc-refit">${d.refit}</div>` : '');
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 3600);
  }

  /** Name of the zone the ship is flying through, shown next to the level. */
  setZone(sector) {
    if (this.zoneName) this.zoneName.textContent = sector.name;
  }

  // --- settings ------------------------------------------------------------------

  cycleSpeed() {
    const opts = speedOptions(this.state.meta.lab.labSpeed);
    const cur = this.state.meta.settings.speed || 1;
    const next = opts[(opts.indexOf(cur) + 1) % opts.length] || 1;
    this.state.meta.settings.speed = next;
    this.game.timeScale = next;
    this.state.markDirty();
    this.updateSpeedButton();
  }

  updateSpeedButton() {
    const sp = this.state.meta.settings.speed || 1;
    this.speedBtn.textContent = sp + '×';
    this.game.timeScale = sp;
  }

  toggleSound() {
    const on = !this.state.meta.settings.sound;
    this.state.meta.settings.sound = on;
    this.synth.setEnabled(on);
    this.soundBtn.classList.toggle('off', !on);
    this.state.markDirty();
  }

  // --- modals -----------------------------------------------------------------

  /**
   * @param {string} id
   * @param {{dismissible?: boolean, returnTo?: string|null}} [opts]
   *   `dismissible: false` refuses backdrop taps and Escape — used for the
   *   death screen, which must be answered rather than waved away.
   *   `returnTo` sends the player back to that modal on close instead of to the
   *   battlefield, so opening the Lab from the death screen is not a one-way trip.
   */
  showModal(id, opts = {}) {
    if (id === 'modalLab') this.buildLab();
    if (id === 'modalMenu') this.buildMenuStats();
    this.modalRoot.hidden = false;
    for (const m of this.modalRoot.querySelectorAll('.modal')) m.hidden = m.id !== id;
    this.openModal = id;
    this.modalDismissible = opts.dismissible !== false;
    this.modalReturnTo = opts.returnTo || null;
    this.game.paused = true;
  }

  /** Close even a locked dialog — for the code paths that legitimately resolve it. */
  forceHideModal() {
    this._forceClose = true;
    this.modalReturnTo = null;
    this.hideModal();
    this._forceClose = false;
  }

  hideModal() {
    if (!this.modalDismissible && !this._forceClose) return;

    const back = this.modalReturnTo;
    this.modalReturnTo = null;
    if (back) { this.showModal(back, { dismissible: false }); return; }

    // Backstop: a lost run has exactly one way out, and that is REBUILD. If
    // anything closes the dialog while the bastion is dead, put it straight
    // back rather than leaving the player staring at a frozen battlefield.
    if (this.state.run.over && !this._forceClose) { this.showRunOver(); return; }

    this.modalRoot.hidden = true;
    this.openModal = null;
    this.game.paused = false;
  }

  buildMenuStats() {
    const { meta, run } = this.state;
    const rows = [
      ['CURRENT WAVE', run.wave],
      ['BEST WAVE', meta.bestWave],
      ['ASCENSIONS', meta.prestiges],
      ['TOTAL KILLS', fmt(meta.totalKills)],
      ['RUNS', meta.totalRuns],
      ['CORES', fmt(meta.cores)],
    ];
    this.menuStats.innerHTML = rows
      .map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  }

  showAscend() {
    const { run, meta } = this.state;
    const cores = coresForRun(run.wave, meta.lab.labCoreYield || 0);
    this.$('ascWave').textContent = run.wave;
    this.$('ascCores').textContent = fmt(cores);
    this.$('ascHint').textContent = cores === 0
      ? 'Reach at least wave 5 before ascending is worth anything.'
      : 'You will restart at level 1 with every Lab bonus intact.';
    this.showModal('modalAscend');
  }

  showRunOver() {
    const { run, meta } = this.state;
    // Already paid out by state.bankRun() the moment the bastion fell — this
    // only reports it, so the number can never disagree with the wallet.
    const cores = run.bankedCores || 0;
    this.$('overWave').textContent = run.wave;
    this.$('overKills').textContent = fmt(run.kills);
    this.$('overCores').textContent = fmt(cores);
    this.$('overHint').textContent = run.wave >= meta.bestWave
      ? 'A new record — Cores already banked. Spend them in the Lab before the next sortie.'
      : 'Cores are banked and permanent. Buy research, then push deeper.';
    this.showModal('modalOver', { dismissible: false });
  }

  confirmWipe() {
    if (!confirm('Erase all progress — Cores, research, records? This cannot be undone.')) return;
    this._forceClose = true;
    this.state.reset();
    location.reload();
  }

  toast(text, kind = '', big = false) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind + (big ? ' big' : '');
    el.textContent = text;
    this.toasts.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }
}
