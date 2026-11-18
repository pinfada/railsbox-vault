// Un DOM FACTICE pour rejouer, dans Node, le VRAI câblage de la page (#265) : la campagne de mutation ne
// lance que `node --test`, donc le câblage qu'elle mute doit s'exécuter ici. Ce n'est pas un navigateur :
// chaque comportement dont une épreuve dépend est REJOUÉ sur le DOM réel par `tests/browser/` (trois
// moteurs). Ce qui n'est pas modélisé lève (jamais un silence) : un sélecteur inconnu est une erreur.

const ATTRIBUTS_BOOLEENS = new Set(["hidden", "disabled", "required", "inert"]);

class Evenement {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = init.bubbles !== false;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    Object.assign(this, init);
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class Noeud {
  constructor(doc, nom) {
    this.ownerDocument = doc;
    this.nodeName = nom;
    this.parentNode = null;
    this.childNodes = [];
    this._ecouteurs = new Map();
  }
  get parentElement() {
    return this.parentNode?.estElement ? this.parentNode : null;
  }
  get isConnected() {
    let courant = this;
    while (courant.parentNode !== null) courant = courant.parentNode;
    return courant === this.ownerDocument;
  }
  get children() {
    return this.childNodes.filter((n) => n.estElement);
  }
  _inserer(noeuds, avant = null) {
    for (const n of noeuds) {
      const cible = typeof n === "string" ? this.ownerDocument.createTextNode(n) : n;
      if (cible.estFragment) {
        const enfants = [...cible.childNodes];
        cible.childNodes = [];
        enfants.forEach((e) => (e.parentNode = null));
        this._inserer(enfants, avant);
        continue;
      }
      cible.parentNode?._retirer(cible);
      cible.parentNode = this;
      const rang = avant === null ? this.childNodes.length : this.childNodes.indexOf(avant);
      this.childNodes.splice(rang, 0, cible);
    }
    this.ownerDocument._muter(this, "childList");
  }
  _retirer(enfant) {
    const rang = this.childNodes.indexOf(enfant);
    if (rang >= 0) this.childNodes.splice(rang, 1);
    enfant.parentNode = null;
    this.ownerDocument._muter(this, "childList");
  }
  append(...noeuds) {
    this._inserer(noeuds);
  }
  appendChild(noeud) {
    this._inserer([noeud]);
    return noeud;
  }
  replaceChildren(...noeuds) {
    for (const enfant of [...this.childNodes]) enfant.parentNode = null;
    this.childNodes = [];
    this._inserer(noeuds);
  }
  before(...noeuds) {
    this.parentNode._inserer(noeuds, this);
  }
  remove() {
    this.parentNode?._retirer(this);
  }
  replaceWith(...noeuds) {
    const parent = this.parentNode;
    parent._inserer(noeuds, this);
    parent._retirer(this);
  }
  addEventListener(type, fonction) {
    this._ecouteurs.set(type, [...(this._ecouteurs.get(type) ?? []), fonction]);
  }
  removeEventListener(type, fonction) {
    this._ecouteurs.set(
      type,
      (this._ecouteurs.get(type) ?? []).filter((f) => f !== fonction),
    );
  }
  dispatchEvent(evenement) {
    evenement.target ??= this;
    for (let n = this; n !== null; n = n.parentNode) {
      evenement.currentTarget = n;
      for (const fonction of [...(n._ecouteurs.get(evenement.type) ?? [])]) fonction(evenement);
      if (!evenement.bubbles) break;
    }
    return !evenement.defaultPrevented;
  }
  contains(autre) {
    for (let n = autre; n !== null && n !== undefined; n = n.parentNode)
      if (n === this) return true;
    return false;
  }
}

class Texte extends Noeud {
  constructor(doc, texte) {
    super(doc, "#text");
    this.texte = texte;
  }
  get textContent() {
    return this.texte;
  }
  set textContent(valeur) {
    this.texte = String(valeur);
    this.ownerDocument._muter(this, "characterData");
  }
}

class Fragment extends Noeud {
  estFragment = true;
  constructor(doc) {
    super(doc, "#document-fragment");
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
}

function motif(selecteur) {
  // Un seul compose : `tag#id.classe[attr][attr=val]`, séparés par des espaces (descendants).
  return selecteur
    .trim()
    .split(/\s+/)
    .map((partie) => {
      const m = /^([a-z0-9-]*)((?:[#.][\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(partie);
      if (m === null) throw new Error(`sélecteur non modélisé : ${selecteur}`);
      const conditions = [...m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)];
      return (element) =>
        (m[1] === "" || element.tagName === m[1].toUpperCase()) &&
        conditions.every(([, id, classe, attribut, valeur]) => {
          if (id !== undefined) return element.id === id;
          if (classe !== undefined) return element.classList().includes(classe);
          return valeur === undefined
            ? element.hasAttribute(attribut)
            : element.getAttribute(attribut) === valeur;
        });
    });
}

class Element extends Noeud {
  estElement = true;
  constructor(doc, nom) {
    super(doc, nom.toUpperCase());
    this.tagName = nom.toUpperCase();
    this._attributs = new Map();
    this.dataset = new Proxy(
      {},
      {
        get: (_, cle) => this.getAttribute(`data-${cle}`) ?? undefined,
        set: (_, cle, valeur) => (this.setAttribute(`data-${cle}`, valeur), true),
        deleteProperty: (_, cle) => (this.removeAttribute(`data-${cle}`), true),
        has: (_, cle) => this.hasAttribute(`data-${cle}`),
      },
    );
  }
  classList() {
    return (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  set id(valeur) {
    this.setAttribute("id", valeur);
  }
  getAttribute(nom) {
    return this._attributs.has(nom) ? this._attributs.get(nom) : null;
  }
  setAttribute(nom, valeur) {
    this._attributs.set(nom, String(valeur));
    this.ownerDocument._muter(this, "attributes", nom);
  }
  removeAttribute(nom) {
    if (this._attributs.delete(nom)) this.ownerDocument._muter(this, "attributes", nom);
  }
  hasAttribute(nom) {
    return this._attributs.has(nom);
  }
  toggleAttribute(nom, force) {
    const present = force ?? !this.hasAttribute(nom);
    if (present) this.setAttribute(nom, "");
    else this.removeAttribute(nom);
    return present;
  }
  get textContent() {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(valeur) {
    this.replaceChildren(String(valeur));
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(valeur) {
    this.setAttribute("class", valeur);
  }
  *descendants() {
    for (const enfant of this.children) {
      yield enfant;
      yield* enfant.descendants();
    }
  }
  querySelectorAll(selecteur) {
    const groupes = selecteur.split(",").map(motif);
    return [...this.descendants()].filter((e) => groupes.some((g) => correspond(e, g, this)));
  }
  querySelector(selecteur) {
    return this.querySelectorAll(selecteur)[0] ?? null;
  }
  closest(selecteur) {
    const groupes = selecteur.split(",").map(motif);
    for (let n = this; n !== null && n.estElement; n = n.parentNode) {
      if (groupes.some((g) => correspond(n, g, null))) return n;
    }
    return null;
  }
  focus() {
    if (!this.isConnected || this.closest("[hidden]") !== null || this.disabled) return;
    const avant = this.ownerDocument.activeElement;
    this.ownerDocument.activeElement = this;
    if (avant !== this) avant?.dispatchEvent(new Evenement("blur", { bubbles: false }));
    this.dispatchEvent(new Evenement("focusin"));
  }
  blur() {
    if (this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = this.ownerDocument.body;
  }
  click() {
    if (this.disabled || this.closest("[hidden]") !== null) return;
    this.dispatchEvent(new Evenement("click"));
  }
}

function correspond(element, groupe, racine) {
  // Descendants : le dernier motif vise l'élément, les précédents ses ancêtres, dans l'ordre.
  if (!groupe.at(-1)(element)) return false;
  let rang = groupe.length - 2;
  for (let n = element.parentNode; rang >= 0 && n !== null && n.estElement; n = n.parentNode) {
    if (n === racine) break;
    if (groupe[rang](n)) rang -= 1;
  }
  return rang < 0;
}

for (const nom of ATTRIBUTS_BOOLEENS) {
  Object.defineProperty(Element.prototype, nom, {
    get() {
      return this.hasAttribute(nom);
    },
    set(valeur) {
      this.toggleAttribute(nom, Boolean(valeur));
    },
  });
}
for (const nom of ["title", "href", "type", "name", "download"]) {
  Object.defineProperty(Element.prototype, nom, {
    get() {
      return this.getAttribute(nom) ?? "";
    },
    set(valeur) {
      this.setAttribute(nom, valeur);
    },
  });
}

class Document extends Noeud {
  constructor() {
    super(null, "#document");
    this.ownerDocument = this;
    this.observateurs = [];
    this.documentElement = new Element(this, "html");
    this.body = new Element(this, "body");
    this.documentElement.parentNode = this;
    this.childNodes = [this.documentElement];
    this.documentElement.childNodes = [this.body];
    this.body.parentNode = this.documentElement;
    this.activeElement = this.body;
    this.defaultView = null;
  }
  createElement(nom) {
    return new Element(this, nom);
  }
  createTextNode(texte) {
    return new Texte(this, texte);
  }
  createDocumentFragment() {
    return new Fragment(this);
  }
  getElementById(id) {
    return this.body.querySelector(`#${id}`);
  }
  querySelector(selecteur) {
    return this.body.querySelector(selecteur) ?? null;
  }
  querySelectorAll(selecteur) {
    return this.body.querySelectorAll(selecteur);
  }
  /** Les mutations sont livrées en LOT, au tour de micro-tâches suivant (comme `MutationObserver`). */
  _muter(cible, type, attribut = null) {
    for (const observateur of this.observateurs)
      observateur._noter({ target: cible, type, attributeName: attribut });
  }
  /** Construit une page à partir de balises simples : `[ [tag, {attrs}, texte?] ]` posées dans `<body>`. */
  poser(descriptions) {
    for (const [nom, attributs = {}, texte = ""] of descriptions) {
      const e = this.createElement(nom);
      for (const [cle, valeur] of Object.entries(attributs))
        e.setAttribute(cle, valeur === true ? "" : valeur);
      if (texte !== "") e.textContent = texte;
      this.body.append(e);
    }
    return this;
  }
}

export function documentFactice() {
  const doc = new Document();
  doc.MutationObserver = class {
    constructor(rappel) {
      this.rappel = rappel;
      this.enAttente = [];
      this.cibles = [];
    }
    observe(cible, options) {
      this.cibles.push({ cible, options });
      if (!doc.observateurs.includes(this)) doc.observateurs.push(this);
    }
    disconnect() {
      doc.observateurs = doc.observateurs.filter((o) => o !== this);
    }
    _noter(enregistrement) {
      const visee = this.cibles.some(
        ({ cible, options }) =>
          (cible === enregistrement.target ||
            (options?.subtree && cible.contains(enregistrement.target))) &&
          (enregistrement.type === "attributes"
            ? options?.attributes
            : enregistrement.type === "childList"
              ? options?.childList
              : options?.characterData),
      );
      if (!visee) return;
      this.enAttente.push(enregistrement);
      if (this.enAttente.length === 1) {
        queueMicrotask(() => {
          const lot = this.enAttente.splice(0);
          if (lot.length > 0) this.rappel(lot, this);
        });
      }
    }
  };
  return doc;
}

export { Evenement };
