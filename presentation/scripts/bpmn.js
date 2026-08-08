/* ==========================================================================
   BPMN theatre — bpmn.io viewer with tabs, guided playback and a detail panel.
   Diagram sources are injected by the build script into window.__DIAGRAMS__.
   ========================================================================== */
(function () {
  'use strict';

  var XML = window.__DIAGRAMS__ || {};

  /* ---- narrative metadata ---------------------------------------------- */
  var META = {
    avant: {
      StartEvent_1: { role: 'Auteur Méthode', note: "Un ticket arrive : une méthode doit être modifiée." },
      Task_Copie: { role: 'Auteur Méthode', note: "Le dossier « Univers » contient « En ligne » et « En rédaction ». On duplique, on renomme avec le numéro de ticket, on ajoute son nom et la date. La concurrence est gérée à la main.", cost: 'Collaboration + traçabilité — 0,2 j × 6 pers.' },
      Task_UploadTest: { role: 'Auteur Méthode', note: "Upload manuel sur rFlow. Ça passe, ou ça renvoie une erreur : aucun contrôle de qualité avant l'envoi." },
      Task_Recette: { role: 'Auteur, Validateur, Technique', note: "Non-régression faite à la main, dans un environnement de test partagé : aucune isolation entre auteurs, deux méthodes peuvent se marcher dessus.", cost: 'Environnement de test — sans propriétaire dédié' },
      Task_UploadProd: { role: 'Responsable mise en prod', note: "Second upload manuel sur rFlow. Même absence de contrôle automatisé que pour le test.", cost: 'Mise en prod — 2 j × 6 pers. = 12 jh' },
      Task_NonRegProd: { role: 'Auteur & Validateur', note: "La non-régression est refaite ici. Le filet de sécurité arrive après la mise en ligne, pas avant." },
      EndEvent_1: { role: 'Production', note: "Une version live unique et partagée, sans historique de ce qui a changé." }
    },
    'apres-dev': {
      Start_Dev: { role: 'Auteur Méthode', note: "Même point de départ : un ticket, une méthode à faire évoluer." },
      Task_Local: { role: 'Auteur Méthode', note: "Airflow + Camunda en local, ou Spring Boot avec workers mockés. La méthode s'exécute avant même d'être poussée.", cost: 'Pilier 3 — environnements locaux' },
      Task_Commit: { role: 'Auteur Méthode', note: "Branche nommée feature/BDM-123456-slug, créée sans upstream automatique : un push ne peut pas atterrir par surprise sur la branche partagée.", cost: 'Pilier 1 — Gitflow' },
      Task_MR: { role: 'Relecteur', note: "Diff visuel BPMN : les éléments ajoutés et modifiés sont surlignés sur le diagramme, les supprimés listés à côté. Pas de XML à lire." },
      Gateway_MR: { role: 'Relecteur', note: "Rien n'entre dans develop sans revue. Le refus renvoie l'auteur dans sa branche, pas dans un environnement partagé." },
      Task_MergeDevelop: { role: 'Relecteur', note: "Fusion dans develop une fois la MR approuvée." },
      Task_Pipeline: { role: 'CI/CD — automatique', note: "Build, tests camunda-bpm-assert, scan SonarQube. Sur develop, le scan informe mais ne bloque jamais.", cost: 'Pilier 2 — CI/CD' },
      Task_Preprod: { role: 'CI/CD — automatique', note: "Déploiement automatique en préproduction à chaque push sur develop." },
      End_Preprod: { role: 'Équipe', note: "Revue fonctionnelle possible sur un environnement réel : la méthode est « livrée »." }
    },
    'apres-prod': {
      Start_Prod: { role: 'Équipe', note: "La méthode tourne en préproduction, déployée automatiquement." },
      Task_RevueFonc: { role: 'Auteur Méthode & équipe', note: "Revue fonctionnelle sur un environnement isolé — avant la production, plus après." },
      Gateway_Sonar: { role: 'Porte de qualité', note: "Le même scan SonarQube qui informait sur develop devient bloquant ici. Une méthode dont la qualité n'a pas été corrigée n'atteint pas la production.", cost: 'Pilier 4 — SonarQube' },
      End_Retour: { role: 'Auteur Méthode', note: "Retour dans la boucle de développement : correction, nouvelle MR, nouveau passage." },
      Task_Promotion: { role: 'Intégrateur', note: "Une seule action « Intégrer » : merge --no-ff vers main et back-merge vers develop, plus le tag de version.", cost: 'Rôle distinct de l\'auteur' },
      Task_PipelineMain: { role: 'CI/CD — automatique', note: "Le même pipeline, déclenché par le push sur main. Atteint uniquement si la porte de qualité est franchie." },
      Task_Deploy: { role: 'CI/CD — automatique', note: "Publication sur le moteur Camunda ; rFlow exécute les méthodes déployées." },
      End_Prod: { role: 'Production', note: "0,5 j × 1 pers. au lieu de 2 j × 6 pers. — et un historique Git complet de ce qui a changé.", cost: 'Objectif ciblé, non mesuré' }
    },
    integration: {
      Start_Int: { role: 'Intégrateur', note: "Plusieurs méthodes sont prêtes sur develop : on regroupe une livraison." },
      Task_CreateRelease: { role: 'Intégrateur', note: "Le plugin suggère la version suivante ; la branche release/x.y.z part de develop." },
      Task_ValidateTag: { role: 'Intégrateur', note: "Le tag est validé avant l'intégration — le versioning ne repose plus sur la discipline de chacun." },
      Gateway_Split: { role: 'Plugin', note: "Gitflow standard demande deux commandes séparées. Ici, une seule action déclenche les deux fusions." },
      Task_MergeMain: { role: 'Plugin', note: "La livraison arrive en production via main, avec un merge explicite (--no-ff) qui garde la trace de la release." },
      Task_BackMerge: { role: 'Plugin', note: "Le retour vers develop : l'étape que tout le monde oublie. Son absence est détectée automatiquement." },
      Task_Tag: { role: 'Intégrateur', note: "Tag posé et poussé — le pipeline main prend le relais." },
      End_Int: { role: 'Intégrateur', note: "Une release intégrée des deux côtés, sans divergence silencieuse entre main et develop." }
    },
    pipeline: {
      Start_Push: { role: 'Déclencheur', note: "Chaque push sur develop lance le pipeline. Aucune action manuelle." },
      Stage_Build: { role: 'CI/CD', note: "Compilation du projet et des méthodes." },
      Stage_Tests: { role: 'CI/CD', note: "Tests d'exécution du workflow avec camunda-bpm-assert." },
      Boundary_Fail: { role: 'CI/CD', note: "Un test qui échoue interrompt le pipeline — c'est là que la non-régression se joue désormais." },
      End_Fail: { role: 'CI/CD', note: "Rien n'est déployé, l'auteur est notifié. Avant BDM 2.0, l'erreur se découvrait en production." },
      Stage_Sonar: { role: 'SonarQube', note: "Qualité du BPMN : nommage, flux orphelins, complexité des gateways, documentation minimale. Informatif sur develop." },
      Stage_Deploy: { role: 'CI/CD', note: "Déploiement automatique en préproduction." },
      End_Pipeline: { role: 'Préproduction', note: "Ce qui prenait 2 jours et 6 personnes se déclenche à chaque push." }
    },
    conflit: {
      Start_Conflit: { role: 'Plugin', note: "Deux personnes ont modifié le même diagramme. Git ne sait pas trancher." },
      Task_Panneau: { role: 'Plugin', note: "Le panneau bascule entièrement en mode résolution. Jamais d'auto-résolution silencieuse, jamais un fichier truffé de marqueurs bruts." },
      Gateway_Choix: { role: 'Auteur Méthode', note: "Résolution au niveau fichier uniquement : un merge ligne à ligne d'un XML BPMN ne produirait ni l'un ni l'autre diagramme." },
      Task_Combine: { role: 'Plugin', note: "Fusionne les deux versions quand les changements ne se chevauchent pas — l'un renomme une tâche, l'autre en ajoute une. Vérifié élément par élément après coup.", cost: 'Correct, ou abstention' },
      Task_Mine: { role: 'Auteur Méthode', note: "Garder ma version du fichier en conflit." },
      Task_Theirs: { role: 'Auteur Méthode', note: "Garder la version de l'équipe." },
      Task_Abort: { role: 'Auteur Méthode', note: "merge --abort : n'affecte jamais le travail déjà commité." },
      End_Abort: { role: 'Plugin', note: "Retour exact à l'état d'avant le merge." },
      Task_Verifier: { role: 'Auteur Méthode', note: "Rendu côte à côte disponible avant de valider. Rien n'est écrit tant que l'utilisateur n'a pas accepté." },
      End_Conflit: { role: 'Plugin', note: "Merge finalisé, diagramme lisible, historique propre." }
    }
  };

  /* ---- playback order --------------------------------------------------- */
  var SEQ = {
    avant: ['StartEvent_1', 'Task_Copie', 'Task_UploadTest', 'Task_Recette', 'Task_UploadProd', 'Task_NonRegProd', 'EndEvent_1'],
    'apres-dev': ['Start_Dev', 'Task_Local', 'Task_Commit', 'Task_MR', 'Gateway_MR', 'Task_MergeDevelop', 'Task_Pipeline', 'Task_Preprod', 'End_Preprod'],
    'apres-prod': ['Start_Prod', 'Task_RevueFonc', 'Gateway_Sonar', 'End_Retour', 'Task_Promotion', 'Task_PipelineMain', 'Task_Deploy', 'End_Prod'],
    integration: ['Start_Int', 'Task_CreateRelease', 'Task_ValidateTag', 'Gateway_Split', 'Task_MergeMain', 'Task_BackMerge', 'Task_Tag', 'End_Int'],
    pipeline: ['Start_Push', 'Stage_Build', 'Stage_Tests', 'Boundary_Fail', 'End_Fail', 'Stage_Sonar', 'Stage_Deploy', 'End_Pipeline'],
    conflit: ['Start_Conflit', 'Task_Panneau', 'Gateway_Choix', 'Task_Combine', 'Task_Mine', 'Task_Theirs', 'Task_Abort', 'End_Abort', 'Task_Verifier', 'End_Conflit']
  };

  /* permanent colour accents */
  var STATIC = {
    avant: { pain: ['Task_UploadTest', 'Task_Recette', 'Task_UploadProd', 'Task_NonRegProd'] },
    'apres-dev': { gain: ['Task_Local', 'Task_MR', 'Task_Pipeline'] },
    'apres-prod': { gain: ['Gateway_Sonar', 'Task_Promotion'] },
    integration: { gain: ['Task_BackMerge'] },
    pipeline: { pain: ['End_Fail'], gain: ['Stage_Sonar'] },
    conflit: { gain: ['Task_Combine'] }
  };

  var LABELS = {
    avant: 'Fonctionnement actuel',
    'apres-dev': 'Boucle de développement',
    'apres-prod': 'Promotion vers la production',
    integration: 'Intégration release / hotfix',
    pipeline: 'Pipeline CI/CD',
    conflit: 'Résolution de conflit'
  };

  /* ---- theatre ---------------------------------------------------------- */
  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    return {
      fill: cs.getPropertyValue('--bpmn-fill').trim() || '#161c26',
      stroke: cs.getPropertyValue('--bpmn-stroke').trim() || '#93a4bb',
      label: cs.getPropertyValue('--bpmn-label').trim() || '#dbe4f0'
    };
  }

  function Theatre(root) {
    this.root = root;
    this.keys = (root.dataset.diagrams || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    this.instances = {};
    this.current = this.keys[0];
    this.timer = null;
    this.step = -1;
    this.build();
  }

  Theatre.prototype.build = function () {
    var self = this;
    var html = '';

    if (this.keys.length > 1) {
      html += '<div class="bpmn-tabs"><div class="seg">';
      this.keys.forEach(function (k, i) {
        html += '<button data-k="' + k + '"' + (i === 0 ? ' class="on"' : '') + '>' + (LABELS[k] || k) + '</button>';
      });
      html += '</div></div>';
    }

    html +=
      '<div class="bpmn-toolbar">' +
      '<button class="btn" data-act="play" title="Dérouler le flux">▶ Dérouler</button>' +
      '<button class="btn" data-act="step" title="Étape suivante">⏭</button>' +
      '<button class="btn" data-act="reset" title="Réinitialiser">⟲</button>' +
      '<button class="btn" data-act="out" title="Dézoomer">−</button>' +
      '<button class="btn" data-act="in" title="Zoomer">+</button>' +
      '<button class="btn" data-act="fit" title="Ajuster">⤢</button>' +
      '</div>' +
      '<div class="bpmn-canvas"></div>' +
      '<div class="bpmn-hint">Survolez un élément — molette pour zoomer, glisser pour déplacer</div>' +
      '<div class="bpmn-detail"><div class="d-role"></div><div class="d-title"></div>' +
      '<div class="d-note"></div><div class="d-cost"></div></div>';

    this.root.innerHTML = html;
    this.canvasEl = this.root.querySelector('.bpmn-canvas');
    this.detailEl = this.root.querySelector('.bpmn-detail');

    this.root.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-k]');
      if (tab) {
        self.root.querySelectorAll('[data-k]').forEach(function (b) { b.classList.toggle('on', b === tab); });
        self.activate(tab.dataset.k);
        return;
      }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.dataset.act;
      if (act === 'play') self.play();
      else if (act === 'step') self.advance();
      else if (act === 'reset') self.reset();
      else if (act === 'fit') self.fit();
      else if (act === 'in') self.zoomBy(1.25);
      else if (act === 'out') self.zoomBy(0.8);
    });
  };

  Theatre.prototype.ensure = function (key) {
    var self = this;
    if (this.instances[key]) return Promise.resolve(this.instances[key]);
    if (!XML[key]) {
      this.canvasEl.innerHTML = '<div style="padding:20px;color:var(--bad);font:13px var(--font-mono)">Diagramme introuvable : ' + key + '</div>';
      return Promise.reject(new Error('missing diagram ' + key));
    }

    var host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;display:none';
    host.dataset.host = key;
    this.canvasEl.appendChild(host);

    var c = themeColors();
    var viewer = new window.BpmnJS({
      container: host,
      bpmnRenderer: {
        defaultFillColor: c.fill,
        defaultStrokeColor: c.stroke,
        defaultLabelColor: c.label
      }
    });

    return viewer.importXML(XML[key]).then(function () {
      var inst = { viewer: viewer, host: host, canvas: viewer.get('canvas'), registry: viewer.get('elementRegistry') };
      self.instances[key] = inst;
      self.decorate(key, inst);
      self.wireHover(key, inst);
      return inst;
    }).catch(function (err) {
      host.innerHTML = '<div style="padding:20px;color:var(--bad);font:13px var(--font-mono)">Erreur d\'import BPMN : ' + err.message + '</div>';
      host.style.display = 'block';
      throw err;
    });
  };

  Theatre.prototype.decorate = function (key, inst) {
    var s = STATIC[key];
    if (!s) return;
    ['pain', 'gain'].forEach(function (cls) {
      (s[cls] || []).forEach(function (id) {
        if (inst.registry.get(id)) inst.canvas.addMarker(id, cls);
      });
    });
  };

  Theatre.prototype.wireHover = function (key, inst) {
    var self = this;
    var meta = META[key] || {};
    inst.host.addEventListener('mouseover', function (e) {
      var g = e.target.closest('.djs-element');
      if (!g) return;
      var id = g.getAttribute('data-element-id');
      if (!id || !meta[id]) return;
      self.showDetail(id, meta[id], inst);
    });
    inst.host.addEventListener('mouseleave', function () {
      if (self.timer) return;
      self.hideDetail();
    });
  };

  Theatre.prototype.showDetail = function (id, m, inst) {
    var el = this.detailEl;
    var bo = inst && inst.registry.get(id);
    var name = (bo && bo.businessObject && bo.businessObject.name) || id;
    el.querySelector('.d-role').textContent = m.role || '';
    el.querySelector('.d-title').textContent = name;
    el.querySelector('.d-note').textContent = m.note || '';
    var cost = el.querySelector('.d-cost');
    cost.textContent = m.cost || '';
    cost.style.display = m.cost ? '' : 'none';
    el.classList.add('on');
  };

  Theatre.prototype.hideDetail = function () {
    this.detailEl.classList.remove('on');
  };

  Theatre.prototype.activate = function (key) {
    var self = this;
    this.stop();
    this.current = key;
    Object.keys(this.instances).forEach(function (k) {
      self.instances[k].host.style.display = k === key ? 'block' : 'none';
    });
    return this.ensure(key).then(function (inst) {
      inst.host.style.display = 'block';
      self.reset();
      self.fit();
      return inst;
    }).catch(function () {});
  };

  Theatre.prototype.fit = function () {
    var inst = this.instances[this.current];
    if (!inst) return;
    inst.canvas.resized();
    inst.canvas.zoom('fit-viewport', 'auto');
    var z = inst.canvas.zoom();
    if (z > 1.05) inst.canvas.zoom(1.05, 'auto');
  };

  Theatre.prototype.zoomBy = function (f) {
    var inst = this.instances[this.current];
    if (!inst) return;
    inst.canvas.zoom(inst.canvas.zoom() * f);
  };

  Theatre.prototype.reset = function () {
    var inst = this.instances[this.current];
    this.stop();
    this.step = -1;
    if (!inst) return;
    (SEQ[this.current] || []).forEach(function (id) {
      if (!inst.registry.get(id)) return;
      inst.canvas.removeMarker(id, 'highlight');
      inst.canvas.removeMarker(id, 'done');
    });
    this.hideDetail();
  };

  Theatre.prototype.advance = function () {
    var inst = this.instances[this.current];
    var seq = SEQ[this.current] || [];
    if (!inst) return false;
    if (this.step >= 0 && seq[this.step]) {
      inst.canvas.removeMarker(seq[this.step], 'highlight');
      inst.canvas.addMarker(seq[this.step], 'done');
    }
    this.step++;
    if (this.step >= seq.length) { this.step = seq.length - 1; this.stop(); return false; }
    var id = seq[this.step];
    if (!inst.registry.get(id)) return this.advance();
    inst.canvas.addMarker(id, 'highlight');
    var m = (META[this.current] || {})[id];
    if (m) this.showDetail(id, m, inst);
    return true;
  };

  Theatre.prototype.play = function () {
    var self = this;
    if (this.timer) { this.stop(); return; }
    if (this.step >= (SEQ[this.current] || []).length - 1) this.reset();
    var btn = this.root.querySelector('[data-act="play"]');
    if (btn) btn.textContent = '⏸ Pause';
    this.advance();
    this.timer = setInterval(function () {
      if (!self.advance()) self.stop();
    }, 2400);
  };

  Theatre.prototype.stop = function () {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    var btn = this.root.querySelector('[data-act="play"]');
    if (btn) btn.textContent = '▶ Dérouler';
  };

  Theatre.prototype.destroy = function () {
    var self = this;
    this.stop();
    Object.keys(this.instances).forEach(function (k) {
      try { self.instances[k].viewer.destroy(); } catch (e) {}
      self.instances[k].host.remove();
    });
    this.instances = {};
    this.step = -1;
  };

  /* ---- wiring ----------------------------------------------------------- */
  var theatres = [];

  function initAll() {
    document.querySelectorAll('.bpmn-theatre').forEach(function (root) {
      var t = new Theatre(root);
      theatres.push(t);
      root.__theatre = t;

      var slide = root.closest('.slide');
      if (!slide) { t.activate(t.current); return; }
      slide.addEventListener('slide:enter', function () {
        t.activate(t.current);
      });
      slide.addEventListener('slide:leave', function () { t.stop(); });
      /* core.js may have activated slide 1 before this listener existed */
      if (slide.classList.contains('is-active')) t.activate(t.current);
    });
  }

  document.addEventListener('theme:change', function () {
    theatres.forEach(function (t) {
      var key = t.current;
      t.destroy();
      var slide = t.root.closest('.slide');
      if (slide && slide.classList.contains('is-active')) t.activate(key);
      else t.current = key;
    });
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})();
