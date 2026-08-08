/* ==========================================================================
   Interactive widgets: gain calculator, Gitflow simulator, CI/CD runner,
   RACI matrix, feature explorer, conflict demo, architecture map.
   ========================================================================== */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ======================================================================
     Generic segmented toggles: .seg[data-group] + [data-panel-group]
     ====================================================================== */
  function initToggles() {
    $$('.seg[data-group]').forEach((seg) => {
      seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-panel]');
        if (!btn) return;
        const group = seg.dataset.group;
        $$('button[data-panel]', seg).forEach((b) => b.classList.toggle('on', b === btn));
        $$(`[data-panel-group="${group}"]`).forEach((p) => {
          p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.panel);
        });
        /* a viewer sized while hidden measures 0 — refit once it is on screen */
        requestAnimationFrame(() => {
          $$(`[data-panel-group="${group}"]:not(.hidden) .bpmn-theatre`).forEach((el) => {
            if (el.__theatre) el.__theatre.activate(el.__theatre.current);
          });
        });
        document.dispatchEvent(new CustomEvent('toggle:' + group, { detail: btn.dataset.panel }));
      });
    });
  }

  /* ======================================================================
     1. Gain calculator
     ====================================================================== */
  const AVANT_MEP = 12;      // 2 j x 6 pers
  const AVANT_COLLAB = 1.2;  // 0,2 j x 6 pers
  const AVANT_TOTAL = AVANT_MEP + AVANT_COLLAB; // 13,2 jh
  const APRES_TOTAL = 0.5;   // 0,5 j x 1 pers

  function initCalc() {
    const root = $('#calc');
    if (!root) return;

    const slider = $('#calc-n', root);
    const nOut = $('#calc-nv', root);
    const saved = $('#calc-saved', root);
    const barA = $('#bar-avant', root);
    const barB = $('#bar-apres', root);
    const valA = $('#val-avant', root);
    const valB = $('#val-apres', root);

    function paint(animate) {
      const n = +slider.value;
      nOut.textContent = n;
      const total = (AVANT_TOTAL - APRES_TOTAL) * n;
      if (animate) {
        window.Deck.countTo(saved, total, { decimals: 0, duration: 700 });
      } else {
        saved.textContent = Math.round(total).toString();
      }
      barA.style.width = '100%';
      barB.style.width = (APRES_TOTAL / AVANT_TOTAL) * 100 + '%';
      valA.textContent = (AVANT_TOTAL * n).toFixed(0).replace('.', ',');
      valB.textContent = (APRES_TOTAL * n).toFixed(0).replace('.', ',');
    }

    slider.addEventListener('input', () => paint(false));

    window.Deck.onSlide('s-chiffres', {
      enter() {
        paint(false);
        barA.style.width = '0%';
        barB.style.width = '0%';
        setTimeout(() => paint(true), 16);
        const f = $('#calc-factor');
        const p = $('#calc-pct');
        if (f) window.Deck.countTo(f, 26, { suffix: '×', duration: 1000 });
        if (p) window.Deck.countTo(p, 96, { prefix: '−', suffix: ' %', duration: 1000 });
      }
    });
  }

  /* ======================================================================
     2. Gitflow simulator
     ====================================================================== */
  const LANES = {
    main:    { y: 42,  color: '#4c8dff', label: 'main' },
    hotfix:  { y: 116, color: '#f87171', label: 'hotfix/*' },
    release: { y: 190, color: '#fb923c', label: 'release/*' },
    develop: { y: 264, color: '#a78bfa', label: 'develop' },
    feature: { y: 338, color: '#4ade80', label: 'feature/*' }
  };

  function GitSim(root) {
    this.root = root;
    this.svg = $('#gg-svg', root);
    this.logEl = $('#gg-log', root);
    this.statusEl = $('#gg-status', root);
    this.reset();
    this.wire();
  }

  GitSim.prototype.reset = function () {
    this.x = 90;
    this.n = 0;
    this.ticket = 123456;
    this.version = [1, 4, 0];
    this.commits = [];
    this.heads = {};
    this.open = null;          // 'feature' | 'release' | 'hotfix'
    this.openName = '';
    this.logLines = [];

    this.add('main', 'v1.4.0 en production', [], { tag: 'v1.4.0' });
    this.add('develop', 'base de travail', [this.heads.main]);
    this.render(false);
    this.log('Dépôt initialisé — main est ce qui tourne en production', 'mu');
    this.status();
  };

  GitSim.prototype.add = function (lane, msg, parents, opts) {
    opts = opts || {};
    const c = {
      id: 'c' + this.n++,
      lane: lane,
      x: this.x,
      y: LANES[lane].y,
      msg: msg,
      parents: (parents || []).filter(Boolean),
      tag: opts.tag || null,
      merge: !!opts.merge
    };
    this.x += 64;
    this.commits.push(c);
    this.heads[lane] = c.id;
    return c.id;
  };

  GitSim.prototype.byId = function (id) {
    return this.commits.find((c) => c.id === id);
  };

  GitSim.prototype.log = function (text, cls) {
    this.logLines.push({ text: text, cls: cls || '' });
    if (this.logLines.length > 9) this.logLines.shift();
    this.logEl.innerHTML = this.logLines
      .map((l, i) => `<div class="l ${l.cls}" style="animation-delay:${i * 20}ms">${l.text}</div>`)
      .join('');
    this.logEl.scrollTop = this.logEl.scrollHeight;
  };

  GitSim.prototype.status = function () {
    const b = this.open ? this.openName : 'develop';
    this.statusEl.innerHTML =
      `<span class="dimmer">branche courante</span> <span class="tag">${b}</span>` +
      `<span class="dimmer" style="margin-left:14px">version live</span> <span class="tag">v${this.version.join('.')}</span>`;
    $$('#gg-actions button').forEach((btn) => {
      const a = btn.dataset.a;
      if (a === 'feature') btn.disabled = !!this.open;
      else if (a === 'commit') btn.disabled = this.open !== 'feature' && this.open !== 'hotfix';
      else if (a === 'mr') btn.disabled = this.open !== 'feature';
      else if (a === 'release') btn.disabled = !!this.open;
      else if (a === 'hotfix') btn.disabled = !!this.open;
      else if (a === 'integrate') btn.disabled = this.open !== 'release' && this.open !== 'hotfix';
    });
  };

  GitSim.prototype.act = function (a) {
    const H = this.heads;
    if (a === 'feature') {
      this.ticket += Math.floor(Math.random() * 40) + 3;
      this.openName = `feature/BDM-${this.ticket}-relance-client`;
      this.open = 'feature';
      this.add('feature', 'premier commit', [H.develop]);
      this.log(`git checkout -b ${this.openName} develop --no-track`, '');
      this.log('Départ depuis develop imposé par le modèle — pas une convention à retenir', 'mu');
    } else if (a === 'commit') {
      const lane = this.open;
      this.add(lane, 'modification du diagramme', [this.heads[lane]]);
      this.log('git add . && git commit -m "…"', '');
    } else if (a === 'mr') {
      this.add('develop', 'Merge ' + this.openName.split('/')[1], [H.develop, H.feature], { merge: true });
      this.log('Merge Request approuvée → git merge --no-ff ' + this.openName, 'ok');
      this.open = null;
      this.openName = '';
      delete this.heads.feature;
    } else if (a === 'release') {
      this.version = [this.version[0], this.version[1] + 1, 0];
      this.openName = `release/${this.version.join('.')}`;
      this.open = 'release';
      this.add('release', 'préparation de la livraison', [H.develop]);
      this.log(`git checkout -b ${this.openName} develop`, '');
      this.log(`Version suggérée automatiquement : v${this.version.join('.')}`, 'mu');
    } else if (a === 'hotfix') {
      this.version = [this.version[0], this.version[1], this.version[2] + 1];
      this.openName = `hotfix/${this.version.join('.')}`;
      this.open = 'hotfix';
      this.add('hotfix', 'correction urgente', [H.main]);
      this.log(`git checkout -b ${this.openName} main`, '');
      this.log('Part de main — de ce qui est live, pas de develop', 'wa');
    } else if (a === 'integrate') {
      const src = this.open;
      const head = this.heads[src];
      const tag = 'v' + this.version.join('.');
      this.add('main', 'Merge ' + this.openName, [this.heads.main, head], { merge: true, tag: tag });
      this.add('develop', 'Back-merge ' + this.openName, [this.heads.develop, head], { merge: true });
      this.log(`git merge --no-ff ${this.openName} → main + tag ${tag}`, 'ok');
      this.log(`git merge --no-ff ${this.openName} → develop (back-merge)`, 'ok');
      this.log("Une seule action « Intégrer » : l'oubli du back-merge est impossible", 'mu');
      this.open = null;
      this.openName = '';
      delete this.heads[src];
    } else if (a === 'reset') {
      this.reset();
      return;
    }
    this.render(true);
    this.status();
  };

  GitSim.prototype.render = function (animate) {
    const W = Math.max(1000, this.x + 60);
    const H = 400;
    const used = {};
    this.commits.forEach((c) => (used[c.lane] = true));

    let s = `<svg id="gg-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMid meet">`;

    // lanes
    Object.keys(LANES).forEach((k) => {
      const L = LANES[k];
      const dim = used[k] ? 1 : 0.22;
      s += `<line x1="86" y1="${L.y}" x2="${W - 20}" y2="${L.y}" stroke="${L.color}" stroke-opacity="${0.16 * (used[k] ? 1 : 0.6)}" stroke-width="2" stroke-dasharray="2 6"/>`;
      s += `<text class="gg-branchname" x="10" y="${L.y + 4}" fill="${L.color}" opacity="${dim}">${L.label}</text>`;
    });

    // edges
    this.commits.forEach((c) => {
      c.parents.forEach((pid) => {
        const p = this.byId(pid);
        if (!p) return;
        const col = c.y === p.y ? LANES[c.lane].color : LANES[p.lane].color;
        let d;
        if (c.y === p.y) {
          d = `M${p.x} ${p.y} L${c.x} ${c.y}`;
        } else {
          const mx = (p.x + c.x) / 2;
          d = `M${p.x} ${p.y} C${mx} ${p.y}, ${mx} ${c.y}, ${c.x} ${c.y}`;
        }
        s += `<path d="${d}" fill="none" stroke="${col}" stroke-opacity="0.6" stroke-width="2"/>`;
      });
    });

    // nodes
    this.commits.forEach((c, i) => {
      const col = LANES[c.lane].color;
      const isLast = i === this.commits.length - 1;
      const cls = 'gg-commit' + (animate && isLast ? ' gg-new' : '');
      if (c.merge) {
        s += `<circle class="${cls}" cx="${c.x}" cy="${c.y}" r="8" fill="var(--panel)" stroke="${col}" stroke-width="3"/>`;
      } else {
        s += `<circle class="${cls}" cx="${c.x}" cy="${c.y}" r="7.5" fill="${col}" stroke="var(--panel)" stroke-width="2"/>`;
      }
      if (c.tag) {
        s += `<g class="${cls}"><rect x="${c.x - 26}" y="${c.y - 40}" rx="4" width="52" height="19" fill="${col}" fill-opacity="0.18" stroke="${col}" stroke-opacity="0.6"/>` +
             `<text class="gg-label" x="${c.x}" y="${c.y - 27}" text-anchor="middle" fill="${col}">${c.tag}</text></g>`;
      }
    });

    // head marker
    const headLane = this.open || 'develop';
    const headId = this.heads[headLane];
    const head = this.byId(headId);
    if (head) {
      s += `<circle cx="${head.x}" cy="${head.y}" r="13" fill="none" stroke="${LANES[head.lane].color}" stroke-width="1.5" stroke-dasharray="3 3"><animateTransform attributeName="transform" type="rotate" from="0 ${head.x} ${head.y}" to="360 ${head.x} ${head.y}" dur="8s" repeatCount="indefinite"/></circle>`;
    }

    s += '</svg>';
    this.svg.outerHTML = s;
    this.svg = $('#gg-svg', this.root);
  };

  GitSim.prototype.wire = function () {
    const actions = $('#gg-actions', this.root);
    if (!actions) return;
    actions.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]');
      if (!b || b.disabled) return;
      this.act(b.dataset.a);
    });
  };

  function initGitSim() {
    const root = $('#gitsim');
    if (!root) return;
    new GitSim(root);
  }

  /* ======================================================================
     3. CI/CD runner
     ====================================================================== */
  function initPipeline() {
    const root = $('#cicd');
    if (!root) return;

    const stages = $$('.pipe-stage', root);
    const logEl = $('#cicd-log', root);
    const pushBtn = $('#cicd-push', root);
    const promoBtn = $('#cicd-promote', root);
    const failSw = $('#cicd-fail', root);
    const fixedSw = $('#cicd-fixed', root);
    const targetEl = $('#cicd-target', root);
    let running = false;
    let lines = [];

    function log(text, cls) {
      lines.push(`<div class="l ${cls || ''}">${text}</div>`);
      if (lines.length > 14) lines.shift();
      logEl.innerHTML = lines.join('');
      logEl.scrollTop = logEl.scrollHeight;
    }

    function clearStages() {
      stages.forEach((s) => {
        s.classList.remove('running', 'done', 'failed');
        $('.ps-bar', s).style.width = '0%';
      });
    }

    function runStage(el, ms) {
      return new Promise((resolve) => {
        el.classList.add('running');
        const bar = $('.ps-bar', el);
        const t0 = performance.now();
        /* setInterval rather than rAF: a throttled background tab still
           finishes the run instead of stalling mid-pipeline */
        const iv = setInterval(() => {
          const p = Math.min(1, (performance.now() - t0) / ms);
          bar.style.width = p * 100 + '%';
          if (p >= 1) { clearInterval(iv); el.classList.remove('running'); resolve(); }
        }, 40);
      });
    }

    async function run(branch) {
      if (running) return;
      running = true;
      pushBtn.disabled = true;
      promoBtn.disabled = true;
      clearStages();
      lines = [];

      const prod = branch === 'main';
      targetEl.textContent = prod ? 'production' : 'préproduction';
      targetEl.className = 'badge ' + (prod ? 'b-bad' : 'b-accent');
      log(`$ git push origin ${branch}`, 'mu');
      log(`pipeline déclenché — branche ${branch}`, '');

      await runStage(stages[0], 700);
      stages[0].classList.add('done');
      log('✓ build : 12 méthodes compilées', 'ok');

      await runStage(stages[1], 900);
      if (failSw.checked) {
        stages[1].classList.add('failed');
        log('✗ tests camunda-bpm-assert : 1 échec sur 34', 'er');
        log('   InvoiceProcess — la passerelle « montant > 5000 » ne route plus', 'er');
        log('pipeline interrompu — rien n\'est déployé, l\'auteur est notifié', 'wa');
        running = false;
        pushBtn.disabled = false;
        promoBtn.disabled = false;
        return;
      }
      stages[1].classList.add('done');
      log('✓ tests camunda-bpm-assert : 34/34', 'ok');

      await runStage(stages[2], 800);
      stages[2].classList.add('done');
      if (fixedSw.checked) {
        log('✓ SonarQube : 0 anomalie bloquante', 'ok');
      } else {
        log('⚠ SonarQube : 3 anomalies — 2 tâches sans documentation, 1 flux orphelin', 'wa');
        log(prod ? '' : '  sur develop, le scan informe mais ne bloque pas', 'mu');
      }

      await runStage(stages[3], 700);
      stages[3].classList.add('done');
      log(`✓ déployé en ${prod ? 'production' : 'préproduction'}`, 'ok');
      if (prod) log('rFlow exécute la nouvelle version', 'mu');

      running = false;
      pushBtn.disabled = false;
      promoBtn.disabled = false;
    }

    pushBtn.addEventListener('click', () => run('develop'));

    promoBtn.addEventListener('click', () => {
      if (running) return;
      if (!fixedSw.checked) {
        clearStages();
        lines = [];
        stages[2].classList.add('failed');
        log('$ promotion develop → main', 'mu');
        log('✗ promotion bloquée par la porte de qualité', 'er');
        log('   3 anomalies SonarQube détectées sur develop ne sont pas corrigées', 'er');
        log('   le même scan qui informait devient bloquant ici', 'wa');
        targetEl.textContent = 'bloqué';
        targetEl.className = 'badge b-bad';
        return;
      }
      run('main');
    });

    window.Deck.onSlide('s-cicd', {
      enter() { if (!lines.length) log('En attente d\'un push…', 'mu'); }
    });
  }

  /* ======================================================================
     4. RACI matrix
     ====================================================================== */
  function initRaci() {
    $$('.raci').forEach((table) => {
      table.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-col]');
        if (!th) return;
        const col = +th.dataset.col;
        const already = th.classList.contains('hot');
        $$('th[data-col]', table).forEach((h) => h.classList.remove('hot'));
        $$('td.hot', table).forEach((td) => td.classList.remove('hot'));
        if (already) return;
        th.classList.add('hot');
        $$('tbody tr', table).forEach((tr) => {
          const cell = tr.children[col];
          if (cell) cell.classList.add('hot');
        });
      });
    });
  }

  /* ======================================================================
     5. Feature explorer
     ====================================================================== */
  const MOCK_STATUS = `
    <div class="mock">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="ttl">Git — Mon travail</span></div>
      <div class="mock-body">
        <div class="mock-sec">Modifications non enregistrées</div>
        <div class="mock-file"><span class="st m">MODIFIÉ</span><span class="nm">Relance client</span><span class="path">methodes/relance.bpmn</span></div>
        <div class="mock-file"><span class="st n">NOUVEAU</span><span class="nm">Validation montant</span><span class="path">methodes/validation.dmn</span></div>
        <div class="mock-file"><span class="st d">SUPPRIMÉ</span><span class="nm">Ancien parcours</span><span class="path">methodes/legacy.bpmn</span></div>
        <div class="mock-input">Décrivez ce que vous avez changé…</div>
        <div class="mock-btn">Enregistrer un point de sauvegarde</div>
      </div>
    </div>`;

  const MOCK_MR = `
    <div class="mock">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="ttl">Merge Requests</span></div>
      <div class="mock-body">
        <div class="mock-file"><span class="st a">!42</span><span class="nm">BDM-123456 · Relance client</span><span class="path">2 approbations</span></div>
        <div class="mock-file"><span class="st m">!43</span><span class="nm">BDM-123489 · Validation montant</span><span class="path">conflit</span></div>
        <div class="mock-sec">Diff visuel</div>
        <div class="mock-file"><span class="st a">+</span><span class="nm">Tâche « Notifier le superviseur »</span></div>
        <div class="mock-file"><span class="st m">~</span><span class="nm">Passerelle « Montant &gt; 5000 »</span></div>
        <div class="mock-btn">Ouvrir la revue</div>
      </div>
    </div>`;

  const MOCK_BRANCH = `
    <div class="mock">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="ttl">Sur quoi je travaille</span></div>
      <div class="mock-body">
        <div class="mock-file"><span class="st a">●</span><span class="nm">BDM-123456 · Relance client</span><span class="path">courant</span></div>
        <div class="mock-file"><span class="st n">○</span><span class="nm">BDM-123489 · Validation montant</span></div>
        <div class="mock-file"><span class="st n">○</span><span class="nm">Version publiée</span><span class="path">main</span></div>
        <div class="mock-input">Nouveau sujet de travail — n° de ticket requis</div>
        <div class="mock-btn">Changer de sujet (le travail en cours est sauvegardé)</div>
      </div>
    </div>`;

  const MOCK_CONFLICT = `
    <div class="mock">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="ttl">Résolution — relance.bpmn</span></div>
      <div class="mock-body">
        <div class="mock-sec">Ce fichier a été modifié des deux côtés</div>
        <div class="mock-btn">Combiner les deux</div>
        <div class="mock-file"><span class="nm">Montrer les deux (côte à côte)</span></div>
        <div class="mock-file"><span class="nm">Garder ma version</span></div>
        <div class="mock-file"><span class="nm">Garder celle de l'équipe</span></div>
        <div class="mock-file"><span class="nm">Recommencer</span><span class="path">merge --abort</span></div>
      </div>
    </div>`;

  const MOCK_AI = `
    <div class="mock">
      <div class="mock-bar"><span class="dot"></span><span class="dot"></span><span class="ttl">Modifier avec l'IA</span></div>
      <div class="mock-body">
        <div class="mock-input">Ajoute une relance à 48 h si le client n'a pas répondu</div>
        <div class="mock-sec">Aperçu avant application</div>
        <div class="mock-file"><span class="st a">+</span><span class="nm">Événement minuteur « 48 h »</span></div>
        <div class="mock-file"><span class="st a">+</span><span class="nm">Tâche « Relancer le client »</span></div>
        <div class="mock-file"><span class="st m">~</span><span class="nm">Passerelle « Réponse reçue ? »</span></div>
        <div class="row" style="gap:8px"><div class="mock-btn" style="flex:1">Appliquer</div><div class="mock-file" style="flex:1;justify-content:center">Annuler</div></div>
      </div>
    </div>`;

  const FEATURES = [
    {
      k: 'onboard', icon: '01', t: 'Prise en main guidée', s: 'Une checklist, pas un assistant',
      mock: MOCK_STATUS,
      d: [
        "Pensée pour quelqu'un qui arrive à mi-chemin : le dossier est déjà un dépôt, mais sans aucun commit.",
        "Choisir le dossier ou cloner via un lien, démarrer le suivi (<span class='mono'>git init -b main</span>, jamais master).",
        "L'identité est écrite <strong>par projet</strong>, jamais en <span class='mono'>--global</span> — on ne touche pas à la configuration des autres dépôts.",
        "Le serveur d'équipe est vérifié par <span class='mono'>ls-remote</span> avant d'être accepté : une faute de frappe échoue tout de suite, pas au premier push."
      ]
    },
    {
      k: 'daily', icon: '02', t: 'Usage quotidien', s: 'Statut, diff, commit, push, pull',
      mock: MOCK_STATUS,
      d: [
        "Vocabulaire non technique : <span class='mono'>M</span> devient MODIFIÉ, <span class='mono'>A</span> AJOUTÉ, <span class='mono'>D</span> SUPPRIMÉ, <span class='mono'>?</span> NOUVEAU.",
        "Les extensions <span class='mono'>.bpmn / .dmn / .form</span> sont masquées à l'affichage — on lit un nom de méthode, pas un chemin.",
        "Le chemin brut et la lettre git d'origine restent en infobulle pour les développeurs.",
        "Aucun bouton pour supprimer un travail non commité : trop dangereux, aucune annulation possible."
      ]
    },
    {
      k: 'diff', icon: '03', t: 'Diff visuel BPMN', s: 'Le diagramme, pas le XML',
      mock: MOCK_MR,
      d: [
        "Les éléments ajoutés et modifiés sont surlignés directement sur le diagramme (via <span class='mono'>bpmn-js-differ</span>).",
        "Les éléments supprimés sont listés à côté — ils n'existent plus, on ne peut pas les surligner.",
        "C'est ce qui rend une revue possible pour un non-développeur : personne ne relit un diff XML de 400 lignes."
      ]
    },
    {
      k: 'history', icon: '04', t: 'Historique & activité', s: 'Graphe de branches et journal des commandes',
      mock: MOCK_BRANCH,
      d: [
        "Graphe de branches (DAG) calculé côté processus principal, pour être testable contre un <span class='mono'>git log --graph</span> réel.",
        "Chaque commande git passe par un Proxy autour de <span class='mono'>simple-git</span> : chronométrée, avec son origine (<span class='mono'>user</span> ou <span class='mono'>auto</span>).",
        "L'origine est suivie par <span class='mono'>AsyncLocalStorage</span> — une action de l'utilisateur qui chevauche un pull automatique n'est jamais mal étiquetée.",
        "Le résultat de chaque commande est affiché, replié par défaut, déplié automatiquement en cas d'échec."
      ]
    },
    {
      k: 'errors', icon: '05', t: 'Traduction des erreurs git', s: 'Une phrase claire et une action sûre',
      mock: MOCK_STATUS,
      d: [
        "<span class='mono'>refusing to merge unrelated histories</span> devient « Ces deux projets ont été démarrés séparément », avec un bouton « Combiner quand même ».",
        "Une action n'est proposée que si elle ne peut pas faire perdre de travail.",
        "Une erreur non reconnue garde son texte technique d'origine sous un menu dépliable, plutôt que d'être cachée."
      ]
    },
    {
      k: 'mr', icon: '06', t: 'Merge Request & issues', s: 'La revue sans quitter le modeler',
      mock: MOCK_MR,
      d: [
        "Ouvrir une MR GitLab et suivre son état depuis le modeler.",
        "Plus qu'un lien : le plugin reproduit localement les MR en conflit pour permettre une résolution visuelle.",
        "Les issues GitLab ouvertes sont consultables dans le plugin. La <strong>création</strong> se fait encore sur GitLab — le plugin ouvre l'issue dans le navigateur."
      ]
    },
    {
      k: 'release', icon: '07', t: 'Release & hotfix', s: 'Une action, deux fusions',
      mock: MOCK_BRANCH,
      d: [
        "Version suggérée automatiquement, tag validé avant l'intégration.",
        "Une seule action « Intégrer » fait le double merge <span class='mono'>--no-ff</span> vers main et develop.",
        "Le retour oublié vers develop — l'échec classique et silencieux de Gitflow — est détecté automatiquement."
      ]
    },
    {
      k: 'branches', icon: '08', t: 'Sujets de travail', s: 'Une branche = ce sur quoi je travaille',
      mock: MOCK_BRANCH,
      d: [
        "Le nom affiché est dérivé du nom réel : <span class='mono'>feature/BDM-123456-invoice-approval-redesign</span> devient « BDM-123456 · Invoice approval redesign ».",
        "Jamais stocké séparément — un nom d'affichage en base finit toujours par diverger du nom réel.",
        "Nouvelle branche créée sans upstream (<span class='mono'>--no-track</span>) : un push ne peut pas atterrir en silence sur la branche partagée.",
        "Chaque changement de branche sauvegarde d'abord le travail en cours. « Impossible de changer de branche » n'arrive jamais."
      ]
    },
    {
      k: 'conflict', icon: '09', t: 'Résolution de conflit', s: 'Correct, ou abstention',
      mock: MOCK_CONFLICT,
      d: [
        "Le panneau bascule entièrement en mode résolution. Jamais d'auto-résolution silencieuse, jamais un fichier truffé de marqueurs bruts.",
        "Résolution au niveau fichier uniquement : un merge ligne à ligne d'un XML BPMN ne produirait ni l'un ni l'autre diagramme.",
        "« Combiner les deux » n'est proposé que si la fusion peut être garantie correcte — vérifiée élément par élément après coup.",
        "Gère aussi les rebase, cherry-pick et revert laissés en cours, avec l'inversion correcte de ours/theirs pendant un rebase."
      ]
    },
    {
      k: 'guard', icon: '10', t: 'Garde-fous', s: 'Ce que le plugin refuse de faire',
      mock: MOCK_CONFLICT,
      d: [
        "<strong>Jamais de push direct vers main</strong> en modèle Gitflow. Le mode « fusion directe » n'existe qu'en tronc commun, avec un avertissement à l'écran.",
        "<strong>Mode développeur</strong> (désactivé par défaut, par personne) : ouvre une console git — un exécuteur, pas un shell. Arguments passés directement, jamais via <span class='mono'>sh</span> ou <span class='mono'>cmd</span> : ni pipes, ni <span class='mono'>&amp;&amp;</span>, ni backticks.",
        "<strong>Auto-pull</strong> (désactivé par défaut) : ne se déclenche que si tout est réuni — remote existant, arbre de travail propre, aucun merge à moitié fait. Jamais au démarrage.",
        "Pas de force-push, pas de reset automatique, pas de suppression de travail non sauvegardé."
      ]
    },
    {
      k: 'ai', icon: '11', t: 'IA, catalogue, recherche', s: 'Déjà livré — pas une perspective',
      mock: MOCK_AI,
      d: [
        "<strong>Édition assistée</strong> : on décrit un changement, le modèle renvoie le XML complet. Rien n'est fait confiance — parsé avant d'être proposé, rejeté si invalide, diffé contre l'original, écrit sur disque seulement si l'utilisateur accepte. Jamais commité automatiquement.",
        "Seules deux choses quittent la machine, et seulement sur aperçu explicite : le XML du diagramme et l'instruction.",
        "<strong>Catalogue de patterns</strong> : approbation, boucle de relance, revue parallèle — lus depuis le dossier du plugin, disponibles avant même qu'un projet soit configuré.",
        "<strong>Recherche sémantique</strong> : « toutes les tâches assignées à jdoe », « tout ce qui appelle InvoiceProcess » — une requête plutôt que quarante diagrammes ouverts."
      ]
    }
  ];

  function initFeatures() {
    const list = $('#feat-list');
    const panel = $('#feat-panel');
    if (!list || !panel) return;

    list.innerHTML = FEATURES.map((f, i) => `
      <div class="feat${i === 0 ? ' on' : ''}" data-k="${f.k}">
        <div class="fi">${f.icon}</div>
        <div><div class="ft">${f.t}</div><div class="fs">${f.s}</div></div>
      </div>`).join('');

    function paint(k) {
      const f = FEATURES.find((x) => x.k === k) || FEATURES[0];
      panel.innerHTML = `
        <div class="cols c-3-2 fit">
          <div class="stack" style="overflow:auto">
            <div>
              <div class="kicker" style="margin-bottom:6px">Fonctionnalité ${f.icon}</div>
              <h3 style="font-size:22px">${f.t}</h3>
            </div>
            <ul class="clean">${f.d.map((d) => `<li>${d}</li>`).join('')}</ul>
          </div>
          <div style="overflow:auto">${f.mock}</div>
        </div>`;
    }

    list.addEventListener('click', (e) => {
      const el = e.target.closest('.feat');
      if (!el) return;
      $$('.feat', list).forEach((x) => x.classList.toggle('on', x === el));
      paint(el.dataset.k);
    });

    paint(FEATURES[0].k);
  }

  /* ======================================================================
     6. Conflict resolution demo
     ====================================================================== */
  function initConflictDemo() {
    const root = $('#conf');
    if (!root) return;
    const out = $('#conf-out', root);
    const verdict = $('#conf-verdict', root);

    const RESULTS = {
      combine: {
        cls: 'ok',
        title: 'Combiner les deux',
        items: [
          ['keep', 'Recevoir la demande'],
          ['mine', 'Valider la demande <b>client</b>'],
          ['theirs', 'Notifier le superviseur'],
          ['keep', 'Envoyer au client']
        ],
        note: "Les deux changements portent sur des éléments différents : le renommage et l'ajout coexistent. Le résultat est vérifié élément par élément avant d'être proposé."
      },
      mine: {
        cls: 'warn',
        title: 'Garder ma version',
        items: [
          ['keep', 'Recevoir la demande'],
          ['mine', 'Valider la demande <b>client</b>'],
          ['lost', 'Notifier le superviseur'],
          ['keep', 'Envoyer au client']
        ],
        note: "Le travail de l'équipe sur ce fichier est écarté — visible avant de valider, et l'historique Git le conserve."
      },
      theirs: {
        cls: 'warn',
        title: "Garder celle de l'équipe",
        items: [
          ['keep', 'Recevoir la demande'],
          ['lost', 'Valider la demande <b>client</b>'],
          ['theirs', 'Notifier le superviseur'],
          ['keep', 'Envoyer au client']
        ],
        note: "Mon renommage est écarté au profit de la version de l'équipe."
      },
      abort: {
        cls: 'bad',
        title: 'Recommencer',
        items: [
          ['keep', 'Recevoir la demande'],
          ['keep', 'Valider la demande'],
          ['keep', 'Envoyer au client']
        ],
        note: "<span class='mono'>merge --abort</span> — retour exact à l'état d'avant le merge. N'affecte jamais le travail déjà commité."
      }
    };

    const CHIP = {
      keep: 'style="border-color:var(--line)"',
      mine: 'style="border-color:var(--accent);color:var(--ink)"',
      theirs: 'style="border-color:var(--ok);color:var(--ink)"',
      lost: 'style="border-color:var(--bad);opacity:.45;text-decoration:line-through"'
    };

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-c]');
      if (!b) return;
      $$('button[data-c]', root).forEach((x) => x.classList.toggle('on', x === b));
      const r = RESULTS[b.dataset.c];
      out.innerHTML = r.items.map((it, i) => `
        <div class="mock-file frag-up shown" ${CHIP[it[0]]} style="animation-delay:${i * 60}ms">
          <span class="nm">${it[1]}</span>
        </div>`).join('');
      verdict.className = 'callout ' + r.cls;
      verdict.innerHTML = `<strong>${r.title}.</strong> ${r.note}`;
    });
  }

  /* ======================================================================
     7. Architecture map
     ====================================================================== */
  function initArch() {
    const svg = $('#arch-svg');
    const panel = $('#arch-detail');
    if (!svg || !panel) return;

    const DATA = {
      poste: { t: 'Poste de travail', o: 'Auteur Méthode', d: "Camunda Modeler (Electron). Les panneaux du plugin vivent dans le renderer ; l'accès à git se fait dans le processus principal. Les deux moitiés ne peuvent pas se parler directement : l'allowlist IPC de Modeler est figée, alors le plugin sert une API HTTP en boucle locale (127.0.0.1) avec un jeton régénéré à chaque lancement." },
      local: { t: 'Environnement local', o: 'Auteur Méthode', d: "Option A — Airflow + Camunda en local : parité complète avec la production. Option B — Spring Boot avec workers mockés : léger, suffisant pour tester le comportement du workflow. La méthode s'exécute avant d'être poussée." },
      git: { t: 'Dépôt Git local', o: 'Auteur Méthode', d: "Branches develop, main, feature/*, bugfix/*, hotfix/*, release/*. La configuration partagée .camunda-git.json (modèle de branches, politique de fusion, préfixe de ticket) est committée une fois pour toute l'équipe." },
      gitlab: { t: 'Remote GitLab', o: 'Auteur + Relecteur', d: "Push, Merge Request pour la revue, suivi des issues — sans quitter le modeler. La MR est le point de contrôle : rien n'entre dans develop sans relecture." },
      ci1: { t: 'Pipeline CI/CD (develop)', o: 'Automatique', d: "Déclenché à chaque push : build, tests camunda-bpm-assert, scan SonarQube. Ici le scan est informatif — il n'empêche jamais un déploiement en préproduction." },
      preprod: { t: 'Préproduction', o: 'Auteur + équipe', d: "Déploiement automatique depuis develop. Revue fonctionnelle sur un environnement réel ; si elle est validée, la méthode est « livrée »." },
      promo: { t: 'Promotion vers main', o: 'Intégrateur', d: "Portée par l'Intégrateur, un rôle distinct de l'auteur. Bloquée tant que la qualité SonarQube détectée sur develop n'a pas été corrigée : c'est la porte de qualité du projet." },
      ci2: { t: 'Pipeline CI/CD (main)', o: 'Automatique', d: "Le même pipeline, déclenché par le push sur main : build, tests, déploiement. Atteint uniquement si la promotion a franchi la porte de qualité." },
      prod: { t: 'Production', o: 'Intégrateur / Admin', d: "Moteur Camunda et rFlow. N'est atteinte que si la revue de préproduction et la porte SonarQube sont passées — le contrôle a lieu avant la mise en ligne, plus après." }
    };

    function paint(k) {
      const d = DATA[k];
      if (!d) return;
      panel.innerHTML =
        `<div class="d-role" style="font-family:var(--font-mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:6px">${d.o}</div>` +
        `<h3 style="font-size:17px;margin-bottom:8px">${d.t}</h3>` +
        `<p style="font-size:13px;line-height:1.62;color:var(--ink-2);margin:0">${d.d}</p>`;
      $$('.a-node', svg).forEach((n) => n.classList.toggle('on', n.dataset.k === k));
    }

    svg.addEventListener('mouseover', (e) => {
      const n = e.target.closest('.a-node');
      if (n) paint(n.dataset.k);
    });
    svg.addEventListener('click', (e) => {
      const n = e.target.closest('.a-node');
      if (n) paint(n.dataset.k);
    });

    paint('poste');
  }

  /* ======================================================================
     boot
     ====================================================================== */
  function boot() {
    initToggles();
    initCalc();
    initGitSim();
    initPipeline();
    initRaci();
    initFeatures();
    initConflictDemo();
    initArch();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
