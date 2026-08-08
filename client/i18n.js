/**
 * The panel's text, in English and French.
 *
 * Keyed by the English string itself rather than by an abstract id. That is
 * the unusual choice here, and it is deliberate:
 *
 *   - An untranslated string renders as English, not as `settings.autopull.
 *     label` or a blank. This plugin is used by analysts mid-merge; a missing
 *     key must never turn into a control nobody can read.
 *   - The call site still says what it says. `t('Save my work')` reads like
 *     the button it draws, so the prose can be reviewed without chasing ids
 *     through a second file.
 *   - Adding a language is adding a column, not renaming 350 call sites.
 *
 * The cost is that editing the English text orphans its translation. That is
 * visible rather than silent - the string reverts to English - and
 * `missing()` below lists them for whoever does the next pass.
 *
 * Prose that spans several source lines is joined into one key. Splitting a
 * sentence in half and translating each half separately produces French with
 * English word order, which is the main way a translation like this goes
 * wrong.
 */

const LANGUAGES = [
  { id: 'en', label: 'English' },
  { id: 'fr', label: 'Français' }
];

const FR = {

  // ---- areas and navigation -------------------------------------------
  'My Work': 'Mon travail',
  'Team': 'Équipe',
  'Diagrams': 'Diagrammes',
  'Activity': 'Activité',
  'Settings': 'Paramètres',
  'Git settings': 'Paramètres Git',

  // ---- the daily loop --------------------------------------------------
  'What are you working on?': 'Sur quoi travaillez-vous ?',
  'Start something new': 'Commencer un nouveau travail',
  'Starts from the latest shared version. Your current work is saved first.':
    'Part de la dernière version partagée. Votre travail en cours est enregistré au préalable.',
  'Your current work is saved automatically before switching':
    'Votre travail en cours est enregistré automatiquement avant de changer',
  'What did you change?': 'Qu\'avez-vous modifié ?',
  'Nothing has changed yet': 'Rien n\'a encore été modifié',
  'Save my work': 'Enregistrer mon travail',
  'Yes, do it': 'Oui, continuer',
  'Get in step with the team': 'Se remettre au niveau de l\'équipe',
  'Gets whatever the team has, combines it with your work, and sends yours back - in that order, which is the order that works.':
    'Récupère ce que l\'équipe a produit, le combine avec votre travail, puis renvoie le vôtre - dans cet ordre, le seul qui fonctionne.',
  'Hands your current work back to the team.':
    'Remet votre travail en cours à l\'équipe.',
  'You are on the shared version rather than a workstream, so there is nothing to finish. Start something new first.':
    'Vous êtes sur la version partagée et non sur un chantier : il n\'y a donc rien à terminer. Commencez par un nouveau travail.',
  'Finish this workstream': 'Terminer ce chantier',
  'nothing to hand over yet': 'rien à remettre pour l\'instant',
  'nothing to save': 'rien à enregistrer',
  'Get updates': 'Récupérer les mises à jour',
  'Check for updates from the team': 'Vérifier les mises à jour de l\'équipe',
  'Send your save points to the team': 'Envoyer vos points de sauvegarde à l\'équipe',
  'Switch to it': 'Basculer dessus',
  'you are here': 'vous êtes ici',
  'You are here': 'Vous êtes ici',

  // ---- save points and history ----------------------------------------
  'Every save point on this workstream. You can put your diagrams back to any of them.':
    'Tous les points de sauvegarde de ce chantier. Vous pouvez remettre vos diagrammes à n\'importe lequel d\'entre eux.',
  '(no description)': '(sans description)',
  'where you are now': 'où vous en êtes actuellement',
  'Go back to this': 'Revenir à ceci',
  'Yes, go back to this': 'Oui, revenir à ceci',
  'Last save point': 'Dernier point de sauvegarde',
  'nothing saved yet': 'rien d\'enregistré pour l\'instant',
  'A merge - it combined branches without changing files on its own.':
    'Une fusion - elle a combiné des branches sans modifier de fichiers par elle-même.',
  'No files changed.': 'Aucun fichier modifié.',
  'none - this is the first save point': 'aucun - c\'est le premier point de sauvegarde',
  'a month ago': 'il y a un mois',
  'opened yesterday': 'ouvert hier',
  'active yesterday': 'actif hier',

  // ---- setup -----------------------------------------------------------
  'Choose a folder': 'Choisir un dossier',
  'Get the team\'s project instead': 'Récupérer plutôt le projet de l\'équipe',
  'Paste the address someone sent you. A copy is made on this computer; nothing on the server is changed.':
    'Collez l\'adresse qu\'on vous a envoyée. Une copie est faite sur cet ordinateur ; rien n\'est modifié sur le serveur.',
  'Get a copy': 'Récupérer une copie',
  'Start tracking changes': 'Commencer à suivre les modifications',
  'Your name': 'Votre nom',
  'Starting point': 'Point de départ',
  'Create it': 'Le créer',
  'Checked before it is saved. Nothing is sent until you ask.':
    'Vérifié avant enregistrement. Rien n\'est envoyé sans votre demande.',
  'Open Git Settings to write down which branches the team uses.':
    'Ouvrez les paramètres Git pour indiquer les branches utilisées par l\'équipe.',
  'This project is set up': 'Ce projet est configuré',
  'Let\'s get this project started': 'Mettons ce projet en route',
  'Everything needed is in place. The optional steps below are still worth doing.':
    'Tout le nécessaire est en place. Les étapes facultatives ci-dessous restent utiles.',
  'A few one-off things, then the rest of the plugin works normally.':
    'Quelques réglages ponctuels, puis le reste de l\'extension fonctionne normalement.',

  // ---- detached HEAD ---------------------------------------------------
  'You are not on a workstream right now. You can look around safely, but anything saved here would be hard to find again.':
    'Vous n\'êtes actuellement sur aucun chantier. Vous pouvez regarder sans risque, mais tout ce qui serait enregistré ici serait difficile à retrouver.',
  'Put me back on a workstream': 'Me remettre sur un chantier',
  'Saves anything unsaved first, and gives it its own workstream if it is not already on one. Nothing is discarded.':
    'Enregistre d\'abord ce qui ne l\'est pas, et lui donne son propre chantier s\'il n\'en a pas déjà un. Rien n\'est supprimé.',
  'Not on a workstream (detached)': 'Sur aucun chantier (détaché)',
  'not on a workstream': 'sur aucun chantier',
  'an old version': 'une ancienne version',
  'an old version · not on a workstream': 'une ancienne version · sur aucun chantier',

  // ---- where this project lives ---------------------------------------
  'Show where this project lives': 'Afficher où se trouve ce projet',
  'Hide the details': 'Masquer les détails',
  'Working on': 'Travail en cours sur',
  'Team copy': 'Copie de l\'équipe',
  'none - this project is on this computer only':
    'aucune - ce projet n\'existe que sur cet ordinateur',
  'Saving as': 'Enregistré au nom de',
  'Commits you make are attributed to this':
    'Les enregistrements que vous faites sont attribués à ce nom',
  'not set up - ask whoever set this computer up':
    'non configuré - demandez à la personne qui a préparé cet ordinateur',
  'Set up as': 'Configuré en',
  'merge directly': 'fusion directe',
  'the shared branch': 'la branche partagée',
  'On the team server': 'Sur le serveur de l\'équipe',
  'not on the server yet': 'pas encore sur le serveur',

  // ---- releases --------------------------------------------------------
  'Currently live': 'Actuellement en production',
  'Nothing released yet': 'Rien n\'a encore été livré',
  'In flight': 'En cours',
  'Start the next release': 'Démarrer la prochaine livraison',
  'There is nothing queued to release yet.':
    'Rien n\'est encore en attente de livraison.',
  'Check what this will do': 'Vérifier ce que cela va faire',
  'Cut the release': 'Créer la livraison',
  'Start an urgent fix': 'Démarrer un correctif urgent',
  'An urgent fix to what is live': 'Un correctif urgent sur ce qui est en production',
  'What is broken? e.g. Approvals not sending':
    'Qu\'est-ce qui ne fonctionne pas ? ex. les validations ne partent pas',
  'Ticket (optional)': 'Ticket (facultatif)',

  // ---- merge requests --------------------------------------------------
  'Refresh': 'Actualiser',
  'Review changes': 'Examiner les modifications',
  'See every changed file, before and after':
    'Voir chaque fichier modifié, avant et après',
  'See every changed file, before and after, with synced zoom':
    'Voir chaque fichier modifié, avant et après, avec zoom synchronisé',
  'Resolve in Modeler': 'Résoudre dans Modeler',
  'Bring both branches together here and resolve each diagram visually':
    'Réunir les deux branches ici et résoudre chaque diagramme visuellement',
  'Open this request in the browser': 'Ouvrir cette demande dans le navigateur',
  'No open request': 'Aucune demande ouverte',
  'A private project needs a token - add one under Git Settings.':
    'Un projet privé nécessite un jeton - ajoutez-en un dans les paramètres Git.',
  'This project has no GitHub/GitLab server, so there are no requests to show.':
    'Ce projet n\'a pas de serveur GitHub/GitLab : il n\'y a donc aucune demande à afficher.',

  // ---- the team overview ------------------------------------------------
  'No active workstreams': 'Aucun chantier en cours',
  'Nobody has a workstream open right now - everything is on the shared version.':
    'Personne n\'a de chantier ouvert actuellement - tout est sur la version partagée.',
  'Gone quiet': 'Sans activité',
  'Not sent yet': 'Pas encore envoyé',

  // ---- conflicts --------------------------------------------------------
  'The same diagrams were changed twice': 'Les mêmes diagrammes ont été modifiés deux fois',
  'All decisions made': 'Toutes les décisions sont prises',
  'Nothing is conflicted any more. Finish up to complete this.':
    'Plus aucun conflit. Terminez pour finaliser.',
  'Both versions deleted this diagram.': 'Les deux versions ont supprimé ce diagramme.',
  'These changes do not clash - they can be combined without losing either side.':
    'Ces modifications ne s\'opposent pas - elles peuvent être combinées sans rien perdre de part et d\'autre.',
  'Merge both sets of changes into one diagram. Nothing is discarded.':
    'Fusionner les deux ensembles de modifications en un seul diagramme. Rien n\'est supprimé.',
  'Combine both': 'Combiner les deux',
  'Open both versions side by side': 'Ouvrir les deux versions côte à côte',
  'Show me both': 'Afficher les deux',
  'the other version': 'l\'autre version',
  'Put this file back to needing a decision':
    'Remettre ce fichier en attente de décision',
  'Change my mind': 'Changer d\'avis',
  'Complete this and carry on': 'Finaliser et continuer',
  'Undo this entirely. Your own saved work is not affected.':
    'Tout annuler. Votre propre travail enregistré n\'est pas affecté.',

  // ---- source control ---------------------------------------------------
  'Remove from the next save point': 'Retirer du prochain point de sauvegarde',
  'Include in the next save point': 'Inclure dans le prochain point de sauvegarde',
  'Include every change': 'Inclure toutes les modifications',
  'Include some files first, using the + buttons':
    'Incluez d\'abord des fichiers, avec les boutons +',
  'Ready to save': 'Prêt à enregistrer',
  'Message (Ctrl+Enter to save)': 'Message (Ctrl+Entrée pour enregistrer)',
  'All saved': 'Tout est enregistré',
  'To get': 'À récupérer',
  'To send': 'À envoyer',
  'Remove it': 'Le supprimer',
  'Remove it anyway': 'Le supprimer quand même',

  // ---- files and catalog -------------------------------------------------
  'No diagrams found': 'Aucun diagramme trouvé',
  'No .bpmn, .dmn or .form files in this project yet.':
    'Aucun fichier .bpmn, .dmn ou .form dans ce projet pour l\'instant.',
  'See this diagram in a viewer': 'Voir ce diagramme dans une visionneuse',
  'Drop this straight into the diagram open in the editor':
    'Insérer directement dans le diagramme ouvert dans l\'éditeur',
  'Add to editor': 'Ajouter à l\'éditeur',
  'Add this as a new .bpmn in your project and open it':
    'Ajouter ceci comme nouveau .bpmn dans votre projet et l\'ouvrir',
  'New file': 'Nouveau fichier',
  'Copy the BPMN XML to the clipboard': 'Copier le XML BPMN dans le presse-papiers',
  'Copy XML': 'Copier le XML',

  // ---- AI ----------------------------------------------------------------
  'Add your OpenRouter API key under Git Settings. Then describe a change here and it is applied to a diagram - with a before/after preview, and nothing saved until you accept.':
    'Ajoutez votre clé API OpenRouter dans les paramètres Git. Décrivez ensuite une modification ici : elle sera appliquée à un diagramme - avec un aperçu avant/après, et rien n\'est enregistré tant que vous n\'avez pas accepté.',
  '(no reply)': '(pas de réponse)',
  'Loading the model list…': 'Chargement de la liste des modèles…',
  'Could not load the model list - type an id, saved when you click away':
    'Impossible de charger la liste des modèles - saisissez un identifiant, enregistré quand vous cliquez ailleurs',
  'the configured model': 'le modèle configuré',
  'Generate the edit': 'Générer la modification',
  'Turn the conversation into an edit and preview it':
    'Transformer la conversation en modification et l\'aperçevoir',
  'Start over': 'Recommencer',
  'Ctrl+Enter sends': 'Ctrl+Entrée pour envoyer',
  'The AI did not change anything. Try a more specific instruction.':
    'L\'IA n\'a rien modifié. Essayez une instruction plus précise.',
  'See before / after': 'Voir avant / après',

  // ---- activity ----------------------------------------------------------
  'Command log': 'Journal des commandes',
  'All ran': 'Tout ce qui a été exécuté',
  'By you': 'Par vous',
  'Background only': 'En arrière-plan uniquement',
  'Typed by me': 'Saisi par moi',
  'Nothing has run in the background yet.': 'Rien n\'a encore été exécuté en arrière-plan.',
  'You have not typed any commands yet.': 'Vous n\'avez encore saisi aucune commande.',
  'No commands yet.': 'Aucune commande pour l\'instant.',
  'Show what this command answered': 'Afficher la réponse de cette commande',
  'Hide the output': 'Masquer la sortie',
  'Technical details': 'Détails techniques',
  'Still going - large projects and slow connections take a while.':
    'Toujours en cours - les gros projets et les connexions lentes prennent du temps.',

  // ---- project settings ---------------------------------------------------
  'Shared branch': 'Branche partagée',
  'Everyday work': 'Travail quotidien',
  'Where new work starts from and returns to':
    'D\'où part le nouveau travail et où il revient',
  'What is live': 'Ce qui est en production',
  'Urgent fixes start from here, so it must be what is actually released':
    'Les correctifs urgents partent d\'ici : ce doit donc être ce qui est réellement livré',
  'Ticket prefix': 'Préfixe de ticket',
  'Jira address': 'Adresse Jira',
  'Save these settings': 'Enregistrer ces paramètres',
  'Set this project up': 'Configurer ce projet',

  // ---- personal settings --------------------------------------------------
  'Project folder': 'Dossier du projet',
  'No folder selected': 'Aucun dossier sélectionné',
  'The folder containing your diagrams. It should already be set up for the team.':
    'Le dossier qui contient vos diagrammes. Il devrait déjà être configuré pour l\'équipe.',
  'Check for the team\'s updates in the background':
    'Vérifier les mises à jour de l\'équipe en arrière-plan',
  'Check now': 'Vérifier maintenant',
  'Review first': 'Examen préalable',
  'Combine directly': 'Combiner directement',
  'GitLab host': 'Hôte GitLab',
  'GitHub token': 'Jeton GitHub',
  'GitLab token': 'Jeton GitLab',
  'API key': 'Clé API',
  'Report a problem': 'Signaler un problème',
  'Save settings': 'Enregistrer les paramètres',
  'Let me type git commands in the Activity tab':
    'M\'autoriser à saisir des commandes git dans l\'onglet Activité',
  'Runs whatever you type against this project, including commands that can throw work away. There is no confirmation and no undo - leave this off unless you use git directly.':
    'Exécute tout ce que vous saisissez sur ce projet, y compris des commandes capables de détruire du travail. Il n\'y a ni confirmation ni annulation - laissez cette option désactivée sauf si vous utilisez git directement.',
  'Language': 'Langue',
  'The language of this panel. Personal to this computer - it changes nothing for the rest of the team.':
    'La langue de ce panneau. Propre à cet ordinateur - cela ne change rien pour le reste de l\'équipe.',
  'Areas this project shows': 'Zones affichées par ce projet',

  // ---- status bar and progress ---------------------------------------------
  'Checking your diagrams for changes...': 'Recherche de modifications dans vos diagrammes...',
  'No changes - everything is saved': 'Aucune modification - tout est enregistré',
  'Click to open Source Control': 'Cliquer pour ouvrir le contrôle de source',
  'no team server': 'aucun serveur d\'équipe',
  'Creating a save point': 'Création d\'un point de sauvegarde',
  'Sending your work to the team': 'Envoi de votre travail à l\'équipe',
  'Saving your work': 'Enregistrement de votre travail',
  'Finishing this workstream': 'Finalisation de ce chantier',
  'Putting your diagrams back': 'Restauration de vos diagrammes',
  'Applying your decision': 'Application de votre décision',
  'Combining both versions': 'Combinaison des deux versions',
  'Switching workstream': 'Changement de chantier',
  'Starting the new workstream': 'Démarrage du nouveau chantier',
  'Removing that workstream': 'Suppression de ce chantier',
  'Checking for updates': 'Recherche de mises à jour',
  'Clearing the log': 'Effacement du journal',
  'Running your command': 'Exécution de votre commande',
  'Applying the fix': 'Application du correctif',
  'Saving your settings': 'Enregistrement de vos paramètres',
  'Saving the team settings': 'Enregistrement des paramètres de l\'équipe',
  'Opening the folder chooser': 'Ouverture du sélecteur de dossier',

  // ---- results -------------------------------------------------------------
  'Save point created.': 'Point de sauvegarde créé.',
  'Sent to the team.': 'Envoyé à l\'équipe.',
  'Updates downloaded.': 'Mises à jour récupérées.',
  'Settings saved.': 'Paramètres enregistrés.',
  'Model saved.': 'Modèle enregistré.',
  'Not connected.': 'Non connecté.',
  'Done. Everything is back together.': 'Terminé. Tout est de nouveau réuni.',
  'Cancelled. Nothing was changed.': 'Annulé. Rien n\'a été modifié.',
  'That file needs a decision again.': 'Ce fichier nécessite à nouveau une décision.',
  'New diagram created from the catalog.': 'Nouveau diagramme créé à partir du catalogue.',
  'Applied - saved as a change in Source Control.':
    'Appliqué - enregistré comme modification dans le contrôle de source.',
  'This took too long and was stopped. The team server may be unreachable.':
    'L\'opération a duré trop longtemps et a été interrompue. Le serveur de l\'équipe est peut-être injoignable.',

  // ---- task details (in the editor) -----------------------------------------
  'User task': 'Tâche utilisateur',
  'Service task': 'Tâche de service',
  'Script task': 'Tâche de script',
  'Business rule task': 'Tâche de règle métier',
  'Send task': 'Tâche d\'envoi',
  'Receive task': 'Tâche de réception',
  'Manual task': 'Tâche manuelle',
  'Call activity': 'Activité appelée',
  'Start event': 'Événement de début',
  'End event': 'Événement de fin',
  'Intermediate event': 'Événement intermédiaire',
  'Boundary event': 'Événement de bordure',
  'Exclusive gateway': 'Passerelle exclusive',
  'Parallel gateway': 'Passerelle parallèle',
  'Sequence flow': 'Flux de séquence',
  'Candidate groups': 'Groupes candidats',
  'Candidate users': 'Utilisateurs candidats',
  'Due date': 'Échéance',
  'Follow-up date': 'Date de relance',
  'Form key': 'Clé de formulaire',
  'Form reference': 'Référence de formulaire',
  'Java class': 'Classe Java',
  'Delegate expression': 'Expression de délégation',
  'External task topic': 'Sujet de tâche externe',
  'Decision reference': 'Référence de décision',
  'Called element': 'Élément appelé',
  'Script format': 'Format de script',
  'Input / output': 'Entrée / sortie',
  'For each': 'Pour chaque',
  'one after another': 'l\'un après l\'autre',
  'Only when': 'Seulement quand',
  'Click or press Esc to close': 'Cliquez ou appuyez sur Échap pour fermer',

  // ---- sentences with a value in them ---------------------------------------
  //
  // These carry `{placeholders}` rather than being concatenated around the
  // value, because the value does not sit in the same place in both
  // languages - and a sentence cut in half cannot be reordered at all.
  'back into {branch}': 'de retour dans {branch}',
  '— both, so the next release keeps the change.':
    '— les deux, afin que la prochaine livraison conserve la modification.',
  'This goes onto "{release}", gets marked with a version, and comes back into "{base}" - both, so the next release does not undo it.':
    'Ceci passe sur « {release} », reçoit un numéro de version, puis revient dans « {base} » - les deux, afin que la prochaine livraison ne l\'annule pas.',
  'Takes everything queued on "{base}" onto its own branch, so everyday work can carry on while it is checked.':
    'Place tout ce qui est en attente sur « {base} » sur sa propre branche, afin que le travail quotidien puisse continuer pendant la vérification.',
  'An urgent fix starts from "{release}" - what is actually live, not everyday work - so it can go out without waiting for the next release. When it is done it goes live and comes back into both branches.':
    'Un correctif urgent part de « {release} » - ce qui est réellement en production, et non le travail quotidien - afin de pouvoir sortir sans attendre la prochaine livraison. Une fois terminé, il passe en production et revient dans les deux branches.',
  'Describe what you want changed. {model} asks a few guiding questions first, then generates the edit for you to review.':
    'Décrivez ce que vous voulez modifier. {model} pose d\'abord quelques questions d\'orientation, puis génère la modification que vous pourrez relire.',
  'The team server ({host}) is not GitHub or GitLab, so merge requests are not available here.':
    'Le serveur de l\'équipe ({host}) n\'est ni GitHub ni GitLab : les demandes de fusion ne sont donc pas disponibles ici.',
  'Note: your own changes are the "{side}" side here, because they are being replayed on top of the other version.':
    'Remarque : vos propres modifications sont ici du côté « {side} », car elles sont rejouées par-dessus l\'autre version.',
  'Shared with the team through {file}': 'Partagé avec l\'équipe via {file}',
  'not saved and sent yet, so only you have it.':
    'pas encore enregistré ni envoyé : vous êtes donc seul à l\'avoir.',
  'A problem report was saved to {dir}. Your mail client did not open automatically; attach those files to an email yourself.':
    'Un rapport de problème a été enregistré dans {dir}. Votre client de messagerie ne s\'est pas ouvert automatiquement ; joignez ces fichiers à un e-mail vous-même.',
  'Urgent fix "{title}" started from what is live. Fix it and save, then release it from here - it goes live and comes back into everyday work, both, so the next release does not undo it.':
    'Correctif urgent « {title} » démarré à partir de ce qui est en production. Corrigez et enregistrez, puis livrez-le depuis cet écran - il passe en production et revient dans le travail quotidien, les deux, afin que la prochaine livraison ne l\'annule pas.',
  'Still going - this gets their work and sends yours, so it is two trips to the server.':
    'Toujours en cours - cette opération récupère leur travail et envoie le vôtre : cela fait deux allers-retours vers le serveur.',
  'Also remove it from the team server (this affects everyone)':
    'Le supprimer aussi du serveur de l\'équipe (cela concerne tout le monde)',
  'Send it to the team when done (a release nobody can see is not really released)':
    'L\'envoyer à l\'équipe une fois terminé (une livraison que personne ne voit n\'est pas vraiment livrée)',
  'showing the first results, narrow the search':
    'affichage des premiers résultats, affinez la recherche',
  '{hits} match in {diagrams} diagram · searched {files}':
    '{hits} résultat dans {diagrams} diagramme · {files} fichiers parcourus',
  '{hits} match in {diagrams} diagrams · searched {files}':
    '{hits} résultat dans {diagrams} diagrammes · {files} fichiers parcourus',
  '{hits} matches in {diagrams} diagram · searched {files}':
    '{hits} résultats dans {diagrams} diagramme · {files} fichiers parcourus',
  '{hits} matches in {diagrams} diagrams · searched {files}':
    '{hits} résultats dans {diagrams} diagrammes · {files} fichiers parcourus',

  // ---- fragments that sit next to an icon or a value ------------------------
  'or': 'ou',
  'then': 'puis',
  'this host': 'cet hôte',
  'release / hotfix': 'livraison / correctif urgent',
  '(shared version)': '(version partagée)',
  '(guessed)': '(deviné)',
  '(removed)': '(supprimé)',
  'Added ✓': 'Ajouté ✓',
  'Merge': 'Fusion',
  'Not set up': 'Non configuré',

  // ---- loading and empty states ---------------------------------------------
  'Loading settings...': 'Chargement des paramètres...',
  'Loading diagrams...': 'Chargement des diagrammes...',
  'Loading history...': 'Chargement de l\'historique...',
  'Loading the details...': 'Chargement des détails...',
  'Loading the catalog...': 'Chargement du catalogue...',
  'Loading merge requests...': 'Chargement des demandes de fusion...',
  'Loading the team overview...': 'Chargement de la vue d\'équipe...',
  'Checking how this project is set up...': 'Vérification de la configuration de ce projet...',
  'The catalog is empty.': 'Le catalogue est vide.',
  'No commits yet.': 'Aucun enregistrement pour l\'instant.',
  'No open merge requests right now.': 'Aucune demande de fusion ouverte actuellement.',
  'No BPMN diagrams in this project yet.': 'Aucun diagramme BPMN dans ce projet pour l\'instant.',
  'No changes. Everything is saved.': 'Aucune modification. Tout est enregistré.',
  'Nothing queued.': 'Rien en attente.',
  'Could not load merge requests': 'Impossible de charger les demandes de fusion',
  'Could not load the overview': 'Impossible de charger la vue d\'ensemble',
  'Could not read your changes': 'Impossible de lire vos modifications',
  '...and more': '...et plus encore',

  // ---- headings and small labels --------------------------------------------
  'This will:': 'Cette action va :',
  'New work': 'Nouveau travail',
  'A fix': 'Un correctif',
  'No change': 'Aucune modification',
  'Recent releases': 'Livraisons récentes',
  'Earlier versions': 'Versions antérieures',
  'How this project is organised': 'Comment ce projet est organisé',
  'Get updates automatically': 'Récupérer les mises à jour automatiquement',
  'When someone finishes a workstream': 'Quand quelqu\'un termine un chantier',
  'Team server (optional)': 'Serveur d\'équipe (facultatif)',
  'AI edits (OpenRouter)': 'Modifications par IA (OpenRouter)',
  'Developer mode': 'Mode développeur',
  'AI edits need an OpenRouter key': 'Les modifications par IA nécessitent une clé OpenRouter',
  'This cannot be released yet': 'Ceci ne peut pas encore être livré',
  'Something is broken in what is live': 'Un problème affecte ce qui est en production',
  'You are looking at an old version': 'Vous consultez une ancienne version',
  'Click to see what changed': 'Cliquez pour voir ce qui a changé',
  'Used for this project only.': 'Utilisé uniquement pour ce projet.',
  'Turn on "Developer mode" in Git Settings to run git commands here.':
    'Activez le « mode développeur » dans les paramètres Git pour exécuter des commandes git ici.',
  'jira.example.com - optional, makes ticket numbers clickable':
    'jira.exemple.com - facultatif, rend les numéros de ticket cliquables',
  'Opens a review request. Someone checks the diagrams before they reach the shared version.':
    'Ouvre une demande de relecture. Quelqu\'un vérifie les diagrammes avant qu\'ils n\'atteignent la version partagée.',
  'Finished work goes straight in. Faster, but nothing is checked first.':
    'Le travail terminé est intégré directement. Plus rapide, mais rien n\'est vérifié au préalable.',
  'Search every diagram - a name, or assignee:jdoe, calls:Invoice, type:userTask, timer':
    'Rechercher dans tous les diagrammes - un nom, ou assignee:jdoe, calls:Facture, type:userTask, timer',
  'Type at least two characters. Filters: assignee: group: calls: delegate: form: timer type:':
    'Saisissez au moins deux caractères. Filtres : assignee: group: calls: delegate: form: timer type:',
  'Answer, or say "go ahead" when ready…':
    'Répondez, ou dites « allons-y » quand vous êtes prêt…',
  'e.g. "add a 2-day timer boundary event on Approve invoice"':
    'ex. « ajouter un événement de bordure minuterie de 2 jours sur Valider la facture »',

  // ---- progress -----------------------------------------------------------
  'Including that diagram in your next save point':
    'Inclusion de ce diagramme dans votre prochain point de sauvegarde',
  'Leaving that diagram out of your next save point':
    'Exclusion de ce diagramme de votre prochain point de sauvegarde',
  'Including everything in your next save point':
    'Inclusion de tout dans votre prochain point de sauvegarde',
  'Working out what would be saved': 'Détermination de ce qui serait enregistré',
  'Working out what getting in step would do':
    'Détermination de l\'effet d\'une remise à niveau',
  'Working out what finishing would do': 'Détermination de l\'effet de la finalisation',
  'Working out what would change': 'Détermination de ce qui changerait',
  'Working out what would be written': 'Détermination de ce qui serait écrit',
  'Getting you back in step with the team': 'Remise à niveau avec l\'équipe',
  'Bringing the two branches together so you can resolve them':
    'Réunion des deux branches pour vous permettre de les résoudre',
  'Opening the review': 'Ouverture de la relecture',
  'Asking the AI for an edit': 'Demande d\'une modification à l\'IA',
  'Applying the AI edit': 'Application de la modification de l\'IA',
  'Generating the edit from your conversation':
    'Génération de la modification à partir de votre conversation',
  'Opening the before/after': 'Ouverture de l\'avant/après',
  'Creating the new diagram': 'Création du nouveau diagramme',
  'Compiling the problem report': 'Compilation du rapport de problème',
  'Putting that decision back': 'Rétablissement de cette décision',
  'Opening the two versions': 'Ouverture des deux versions',
  'Finishing up': 'Finalisation',
  'Cancelling and putting everything back': 'Annulation et remise en état',
  'Checking whether that is safe to remove':
    'Vérification que la suppression est sans risque',
  'Cutting the release branch': 'Création de la branche de livraison',
  'Checking what releasing would do': 'Vérification de l\'effet d\'une livraison',
  'Putting it live and bringing it back': 'Mise en production et réintégration',
  'Bringing the live changes back': 'Réintégration des modifications de production',
  'Setting this folder up to track changes':
    'Configuration de ce dossier pour le suivi des modifications',
  'Recording who you are': 'Enregistrement de votre identité',
  'Creating the first save point': 'Création du premier point de sauvegarde',
  'Connecting to the team server': 'Connexion au serveur de l\'équipe',
  'Creating that branch': 'Création de cette branche',

  // Reassurance shown when an operation is taking a while. Kept as whole
  // sentences - they are what someone reads when they are worried.
  'Still sending - this is the network, not your diagrams. Nothing is lost if it fails.':
    'Envoi toujours en cours - il s\'agit du réseau, pas de vos diagrammes. Rien n\'est perdu en cas d\'échec.',
  'Still downloading - large projects take a while over a slow connection or VPN.':
    'Téléchargement toujours en cours - les gros projets prennent du temps sur une connexion lente ou un VPN.',
  'Still going - this fetches from the server and starts the merge.':
    'Toujours en cours - récupération depuis le serveur puis démarrage de la fusion.',
  'Still going - this fetches the two branches to compare them.':
    'Toujours en cours - récupération des deux branches pour les comparer.',
  'Still thinking - the model is rewriting the diagram.':
    'Réflexion en cours - le modèle réécrit le diagramme.',
  'Still going - the model is writing the whole diagram.':
    'Toujours en cours - le modèle écrit le diagramme entier.',
  'Still going - this merges into two branches and marks the version.':
    'Toujours en cours - fusion dans deux branches puis marquage de la version.',
  'Still waiting for the server to answer. Nothing has been sent.':
    'En attente de la réponse du serveur. Rien n\'a été envoyé.',
  'Still copying - a project with a long history can take several minutes.':
    'Copie toujours en cours - un projet avec un long historique peut prendre plusieurs minutes.',

  // ---- prose that spans several source lines --------------------------------
  //
  // Joined into one key each. Half a sentence translated on its own comes
  // back in English word order, which is the main way this goes wrong.
  'Only runs when everything is saved and no decisions are pending, so it can never interrupt you. Everything it does appears in Activity.':
    'Ne s\'exécute que lorsque tout est enregistré et qu\'aucune décision n\'est en attente : cela ne peut donc jamais vous interrompre. Toutes ses actions apparaissent dans Activité.',
  'Only needed for listing issues on private projects. Stored in plain text in your home folder - treat them as low-value tokens.':
    'Nécessaire uniquement pour lister les tickets des projets privés. Stockés en clair dans votre dossier personnel - considérez-les comme des jetons de faible valeur.',
  'Used by the AI Edit tab. Your diagram and instruction are sent to OpenRouter when you preview an edit. The key is stored in plain text in your home folder, like the tokens above.':
    'Utilisée par l\'onglet Modification IA. Votre diagramme et votre instruction sont envoyés à OpenRouter lorsque vous prévisualisez une modification. La clé est stockée en clair dans votre dossier personnel, comme les jetons ci-dessus.',
  'Stuck? This gathers a summary, your recent git activity, the environment, and a secret-free copy of these settings into an email draft with the files attached - for you to review and send. Nothing is sent automatically.':
    'Bloqué ? Ceci rassemble un résumé, votre activité git récente, l\'environnement et une copie sans secrets de ces paramètres dans un brouillon d\'e-mail avec les fichiers joints - à vous de le relire et de l\'envoyer. Rien n\'est envoyé automatiquement.',
  'Nobody has set this project up yet, so the plugin is working it out from the branch names. Writing it down means everyone on the team agrees - including people who have not opened it yet.':
    'Personne n\'a encore configuré ce projet : l\'extension le déduit donc des noms de branches. L\'écrire noir sur blanc garantit que toute l\'équipe s\'accorde - y compris ceux qui ne l\'ont pas encore ouvert.',
  'Apply saves it as an unstaged change in Source Control - review it there, or reopen the diagram, before making a save point.':
    'Appliquer l\'enregistre comme modification non indexée dans le contrôle de source - relisez-la là, ou rouvrez le diagramme, avant de créer un point de sauvegarde.',
  'Both branches are open together. Resolve each diagram below, then Finish and Send - that updates the merge request.':
    'Les deux branches sont ouvertes ensemble. Résolvez chaque diagramme ci-dessous, puis Terminer et envoyer - cela met à jour la demande de fusion.',
  'Nothing to resolve - your branch already has the target\'s changes. Send it and the merge request will be mergeable.':
    'Rien à résoudre - votre branche contient déjà les modifications de la cible. Envoyez-la et la demande de fusion sera fusionnable.',
  'Saved into your project\'s settings file, so everyone on the team sees the same areas. It appears as a change to save and send, like any other. Anyone can turn an area back on from here, so treat this as tidying the panel rather than locking it.':
    'Enregistré dans le fichier de paramètres de votre projet, afin que toute l\'équipe voie les mêmes zones. Cela apparaît comme une modification à enregistrer et à envoyer, comme une autre. N\'importe qui peut réactiver une zone depuis cet écran : considérez donc ceci comme un rangement du panneau, non comme un verrouillage.'
};

const DICTIONARIES = { en: {}, fr: FR };

/**
 * The active language, as a module-level value rather than React context.
 *
 * Context would mean threading a provider through every component and a
 * `useContext` in each one - about 40 files' worth of change for a value that
 * changes at most once a session. The panel re-renders from the top whenever
 * settings load, which is the only moment this can change, so a plain
 * variable is enough and every `t()` call site stays a plain function call.
 */
let current = 'en';

function setLanguage(id) {
  current = DICTIONARIES[id] ? id : 'en';
  return current;
}

function getLanguage() {
  return current;
}

/**
 * Translate. Unknown strings come back untouched, which is what makes an
 * incomplete dictionary safe.
 *
 * `vars` interpolates `{name}` placeholders, so a sentence with a value in
 * the middle stays one translatable unit instead of being concatenated - the
 * pieces around a value do not sit in the same order in French.
 */
function t(text, vars) {
  const dict = DICTIONARIES[current] || {};
  let out = dict[text] || text;

  if (vars) {
    Object.keys(vars).forEach(key => {
      out = out.split(`{${key}}`).join(vars[key]);
    });
  }

  return out;
}

/**
 * The English strings a language has no entry for. Not used by the panel -
 * it is here for the next translation pass, from the console:
 *
 *   require('./i18n').missing('fr')
 */
function missing(language, strings) {
  const dict = DICTIONARIES[language] || {};

  return (strings || []).filter(s => !dict[s]);
}

export { LANGUAGES, DICTIONARIES, setLanguage, getLanguage, t, missing };
