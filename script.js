(() => {
  "use strict";
  const people = Array.isArray(window.FAMILY_DATA) ? window.FAMILY_DATA : [];
  const byId = new Map(people.map(p => [p.id, p]));
  const viewport = document.getElementById("treeViewport");
  const stage = document.getElementById("treeStage");
  const nodes = document.getElementById("treeNodes");
  const generationBands = document.getElementById("generationBands");
  const svg = document.getElementById("connections");
  const search = document.getElementById("searchInput");
  const searchResults = document.getElementById("searchResults");
  const filter = document.getElementById("branchFilter");
  const mainFilter = document.getElementById("mainPersonFilter");
  const empty = document.getElementById("emptyState");
  const panel = document.getElementById("profilePanel");
  const backdrop = document.getElementById("profileBackdrop");
  const profileContent = document.getElementById("profileContent");
  let scale = 0.85, tx = 35, ty = 35, drag = null, activeId = null, lastFocus = null, hasInitialCentered = false;
  const cardW = 156, cardH = 176, gapX = 32, gapY = 100, pad = 35;
  const positions = new Map();

  function safe(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
  function initials(name) { return String(name || "?").trim().split(/\s+/).slice(0,2).map(s => s[0] || "").join("").toUpperCase(); }
  function year(date) { return date ? String(date).slice(0,4) : ""; }

  // Main-branch identifiers and labels used consistently in the website cards and PDFs.
  function branchTagline(person) {
    const labels = {
      p2: { telugu: "పెద్దోళ్ళు", english: "Peddollu", meaning: "Elder son" },
      p3: { telugu: "నడిపోళ్లు", english: "Nadipollu", meaning: "Middle son" },
      p4: { telugu: "చిన్నోళ్లు", english: "Chinnollu", meaning: "Youngest son" }
    };
    return labels[person && person.id] || null;
  }
  function formatDate(date) {
    if (!date) return "";
    const d = new Date(date + "T00:00:00");
    return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined,{year:"numeric",month:"long",day:"numeric"});
  }
  function personAvatar(p, big=false) {
    const cls = big ? "avatar profile-avatar" : "avatar";
    return p.photo
      ? `<div class="${cls}"><img src="${safe(p.photo)}" alt="" onerror="this.parentElement.innerHTML='${safe(initials(p.fullName))}'"></div>`
      : `<div class="${cls}" aria-hidden="true">${safe(initials(p.fullName))}</div>`;
  }
  function childrenCounts(person, list) {
    // Count children linked to this person OR their spouse. Some records list
    // only one parent ID for a child, so both spouses use the combined parent IDs.
    const partnerIds = new Set([
      ...(person.spouseIds || []).filter(Boolean),
      ...people
        .filter(other => (other.spouseIds || []).filter(Boolean).includes(person.id))
        .map(other => other.id)
    ]);
    const familyParentIds = new Set([person.id, ...partnerIds]);
    const children = people.filter(child =>
      (child.parentIds || []).some(parentId => familyParentIds.has(parentId))
    );
    const uniqueChildren = [...new Map(children.map(child => [child.id, child])).values()];
    let sons = 0, daughters = 0;
    uniqueChildren.forEach(child => {
      const gender = String(child.gender || "").trim().toLowerCase();
      if (["male", "m", "man", "boy"].includes(gender)) sons++;
      else if (["female", "f", "woman", "girl"].includes(gender)) daughters++;
    });
    return `${sons} ${sons === 1 ? "son" : "sons"} · ${daughters} ${daughters === 1 ? "daughter" : "daughters"}`;
  }

  function spousePairs(list) {
    const ids = new Set(list.map(p => p.id)), seen = new Set(), pairs = [];
    list.forEach(p => (p.spouseIds || []).filter(Boolean).forEach(sid => {
      if (!ids.has(sid) || sid === p.id) return;
      const a = p.id < sid ? p.id : sid;
      const b = p.id < sid ? sid : p.id;
      const key = `${a}::${b}`;
      if (!seen.has(key)) {
        seen.add(key);
        pairs.push({ a, b });
      }
    }));
    // A relationship may be recorded on only one partner's record.
    list.forEach(p => list.forEach(other => {
      if (p.id === other.id) return;
      const linked = (p.spouseIds || []).includes(other.id) || (other.spouseIds || []).includes(p.id);
      if (!linked) return;
      const a = p.id < other.id ? p.id : other.id;
      const b = p.id < other.id ? other.id : p.id;
      const key = `${a}::${b}`;
      if (!seen.has(key)) { seen.add(key); pairs.push({ a, b }); }
    }));
    return pairs;
  }
  // Classify cards for visual differentiation. A spouse-only card is a person
  // connected through spouseIds who is not already represented as a child or parent
  // in the displayed family branch. Direct descendants retain their gender color.
  function cardType(person, list) {
    const listIds = new Set(list.map(p => p.id));
    const validParents = (person.parentIds || []).some(id => listIds.has(id));
    const hasChildren = list.some(child => (child.parentIds || []).includes(person.id));
    const spouseLinked = (person.spouseIds || []).some(id => listIds.has(id)) ||
      list.some(other => (other.spouseIds || []).includes(person.id));
    if (spouseLinked && !validParents && !hasChildren) return "spouse";
    const gender = String(person.gender || "").trim().toLowerCase();
    if (gender === "female" || gender === "f" || gender === "woman") return "female";
    if (gender === "male" || gender === "m" || gender === "man") return "male";
    return "unknown";
  }

  function ancestorIds(id) {
    const out=new Set(), stack=[id];
    while(stack.length){const cur=byId.get(stack.pop()); if(!cur)continue; (cur.parentIds||[]).forEach(pid=>{if(!out.has(pid)){out.add(pid);stack.push(pid);}});}
    return out;
  }
  function validIds(ids) { return (ids || []).filter(id => id && byId.has(id)); }

  // Resolve the paternal/maternal side from a person's own tag or the nearest
  // tagged ancestor. Descendants do not need duplicate branch labels in the data.
  function branchOfPerson(id) {
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
      const currentId = queue.shift();
      if (!currentId || seen.has(currentId)) continue;
      seen.add(currentId);
      const person = byId.get(currentId);
      if (!person) continue;
      if (person.branch === "paternal" || person.branch === "maternal") return person.branch;
      validIds(person.parentIds).forEach(parentId => queue.push(parentId));
      // A spouse without a recorded parent can inherit the side of their partner.
      validIds(person.spouseIds).forEach(spouseId => queue.push(spouseId));
    }
    return "";
  }

  function topLevelRoots(mode = "all") {
    // Only explicitly tagged top-level people define a family side. Spouses with
    // no parent IDs must not accidentally become separate roots just because they
    // inherit a side through their partner.
    return people.filter(person => {
      const hasKnownParent = validIds(person.parentIds).length > 0;
      const hasSideTag = person.branch === "paternal" || person.branch === "maternal";
      return !hasKnownParent && hasSideTag && (mode === "all" || person.branch === mode);
    });
  }

  function populateMainBranches() {
    const previous = mainFilter.value;
    mainFilter.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "All main branches";
    mainFilter.appendChild(allOption);

    const mode = filter.value;
    const roots = topLevelRoots(mode);
    const groups = new Map();
    roots.forEach(root => {
      const side = root.branch || branchOfPerson(root.id) || "other";
      if (!groups.has(side)) groups.set(side, []);
      people.filter(person => validIds(person.parentIds).includes(root.id))
        .forEach(person => groups.get(side).push(person));
    });

    const labels = { paternal: "Paternal branch", maternal: "Maternal branch", other: "Other branches" };
    groups.forEach((members, side) => {
      if (!members.length) return;
      const group = document.createElement("optgroup");
      group.label = labels[side] || side;
      const seen = new Set();
      members.forEach(person => {
        if (seen.has(person.id)) return;
        seen.add(person.id);
        const option = document.createElement("option");
        option.value = person.id;
        option.textContent = `${person.fullName || person.id} (${person.id})`;
        group.appendChild(option);
      });
      mainFilter.appendChild(group);
    });

    // Preserve the chosen person only if they remain in the current side filter.
    if (previous && [...mainFilter.options].some(option => option.value === previous)) {
      mainFilter.value = previous;
    } else {
      mainFilter.value = "";
    }
    mainFilter.disabled = mainFilter.options.length <= 1;
    updateExportButtonLabel();
  }

  // Keep the selected person's descendants and connected spouses, plus only
  // their direct ancestor chain. This preserves original generation numbering
  // (p1 remains Generation 1, p2/p3/p4 remain Generation 2) without siblings.
  function selectedBranchPeople(startId) {
    if (!byId.has(startId)) return [];
    const keep = new Set();
    const queue = [startId];

    // First collect this branch downward, including spouses/partners.
    while (queue.length) {
      const id = queue.shift();
      if (!id || keep.has(id) || !byId.has(id)) continue;
      keep.add(id);
      const person = byId.get(id);
      validIds(person.spouseIds).forEach(spouseId => queue.push(spouseId));
      people.filter(other => validIds(other.spouseIds).includes(id)).forEach(other => queue.push(other.id));
      people.filter(child => validIds(child.parentIds).includes(id)).forEach(child => queue.push(child.id));
    }

    // Add ancestors only, never their other descendants (siblings/cousin branches).
    const ancestorQueue = validIds(byId.get(startId).parentIds);
    while (ancestorQueue.length) {
      const id = ancestorQueue.shift();
      if (!id || keep.has(id) || !byId.has(id)) continue;
      keep.add(id);
      validIds(byId.get(id).parentIds).forEach(parentId => ancestorQueue.push(parentId));
    }

    return people.filter(person => keep.has(person.id));
  }

  function visiblePeople() {
    const selectedId = mainFilter.value;
    if (selectedId) return selectedBranchPeople(selectedId);
    const mode = filter.value;
    if (mode === "all") return people.slice();
    const roots = topLevelRoots(mode);
    const keep = new Set();
    const queue = roots.map(person => person.id);
    while (queue.length) {
      const id = queue.shift();
      if (!id || keep.has(id) || !byId.has(id)) continue;
      keep.add(id);
      const person = byId.get(id);
      validIds(person.spouseIds).forEach(spouseId => queue.push(spouseId));
      people.filter(other => validIds(other.spouseIds).includes(id)).forEach(other => queue.push(other.id));
      people.filter(child => validIds(child.parentIds).includes(id)).forEach(child => queue.push(child.id));
    }
    return people.filter(person => keep.has(person.id));
  }

  function updateExportButtonLabel() {
    if (!printButton) return;
    const selected = byId.get(mainFilter.value);
    if (selected) {
      printButton.textContent = `Export ${selected.fullName || selected.id} Branch PDF`;
      printButton.title = `Export only ${selected.fullName || selected.id} and their descendants/partners as PDF`;
    } else if (filter.value === "paternal" || filter.value === "maternal") {
      const side = filter.value === "paternal" ? "Paternal" : "Maternal";
      printButton.textContent = `Export ${side} Branch PDF`;
      printButton.title = `Export the ${side.toLowerCase()} branch as PDF`;
    } else {
      printButton.textContent = "Export Full Tree PDF";
      printButton.title = "Export the complete family tree as a shareable PDF";
    }
  }
  const idCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

  function assignPositions(list) {
    positions.clear();
    const ids = new Set(list.map(p => p.id));
    const depthMemo = new Map();
    const depthVisiting = new Set();
    const childrenByParent = new Map();
    const parentForLayout = new Map();
    const spouseOnlyPartner = new Map();
    const spouseOnlyByPartner = new Map();

    // A spouse with no recorded parents or children is placed beside their partner
    // as part of the same layout unit, instead of being treated as a separate root.
    list.forEach(person => {
      const hasParent = (person.parentIds || []).some(pid => ids.has(pid));
      const hasChildren = list.some(child => (child.parentIds || []).includes(person.id));
      if (hasParent || hasChildren) return;
      const linkedSpouseIds = new Set([
        ...(person.spouseIds || []).filter(Boolean),
        ...list.filter(other => (other.spouseIds || []).includes(person.id)).map(other => other.id)
      ]);
      const partner = [...linkedSpouseIds]
        .map(id => byId.get(id))
        .find(candidate => candidate && ids.has(candidate.id) && candidate.id !== person.id &&
          (((candidate.parentIds || []).some(pid => ids.has(pid))) ||
           list.some(child => (child.parentIds || []).includes(candidate.id))));
      if (partner && !spouseOnlyByPartner.has(partner.id)) {
        spouseOnlyPartner.set(person.id, partner.id);
        spouseOnlyByPartner.set(partner.id, person.id);
      }
    });

    // Preserve ID order and give each child one primary layout parent.
    // If a person has multiple parents, all relationships are still drawn below;
    // the first valid parent in parentIds controls the branch placement.
    list.forEach(child => {
      const validParents = (child.parentIds || []).filter(pid => ids.has(pid) && byId.has(pid));
      if (validParents.length) parentForLayout.set(child.id, validParents[0]);
      validParents.forEach(pid => {
        if (!childrenByParent.has(pid)) childrenByParent.set(pid, []);
        childrenByParent.get(pid).push(child.id);
      });
    });
    childrenByParent.forEach(childIds => {
      childIds.sort((a, b) => idCollator.compare(a, b));
    });

    function depth(personId) {
      if (depthMemo.has(personId)) return depthMemo.get(personId);
      if (depthVisiting.has(personId)) return 0;
      depthVisiting.add(personId);
      const partnerId = spouseOnlyPartner.get(personId);
      const parentId = parentForLayout.get(personId);
      const d = partnerId ? depth(partnerId) : (parentId ? depth(parentId) + 1 : 0);
      depthVisiting.delete(personId);
      depthMemo.set(personId, d);
      return d;
    }
    list.forEach(p => depth(p.id));

    // Compute the horizontal width required by every complete descendant branch.
    // This bottom-up measurement prevents branches from overlapping as they grow.
    const widthMemo = new Map();
    const widthVisiting = new Set();
    function subtreeWidth(personId) {
      if (widthMemo.has(personId)) return widthMemo.get(personId);
      if (widthVisiting.has(personId)) return cardW;
      widthVisiting.add(personId);
      const childIds = (childrenByParent.get(personId) || [])
        .filter(cid => parentForLayout.get(cid) === personId);
      const coupleWidth = spouseOnlyByPartner.has(personId) ? cardW * 2 + gapX : cardW;
      let width = coupleWidth;
      if (childIds.length) {
        const childrenWidth = childIds.reduce((sum, cid) => sum + subtreeWidth(cid), 0)
          + gapX * (childIds.length - 1);
        width = Math.max(coupleWidth, childrenWidth);
      }
      widthVisiting.delete(personId);
      widthMemo.set(personId, width);
      return width;
    }
    list.forEach(p => subtreeWidth(p.id));

    // Root branches are laid out left-to-right by ID. Each node is centered over
    // the full horizontal span reserved for its descendants.
    const roots = list
      .filter(p => !parentForLayout.has(p.id) && !spouseOnlyPartner.has(p.id))
      .sort((a, b) => idCollator.compare(a.id, b.id));
    let rootLeft = pad;
    const placed = new Set();

    function placeSubtree(personId, left, d, path = new Set()) {
      if (placed.has(personId) || path.has(personId)) return;
      const person = byId.get(personId);
      if (!person || !ids.has(personId)) return;
      const nextPath = new Set(path);
      nextPath.add(personId);
      const width = subtreeWidth(personId);
      const childIds = (childrenByParent.get(personId) || [])
        .filter(cid => parentForLayout.get(cid) === personId);
      const y = pad + d * (cardH + gapY);
      let x;

      if (!childIds.length) {
        const coupleWidth = spouseOnlyByPartner.has(personId) ? cardW * 2 + gapX : cardW;
        x = left + (width - coupleWidth) / 2;
      } else {
        const childTotal = childIds.reduce((sum, cid) => sum + subtreeWidth(cid), 0)
          + gapX * (childIds.length - 1);
        let childLeft = left + (width - childTotal) / 2;
        childIds.forEach(cid => {
          placeSubtree(cid, childLeft, d + 1, nextPath);
          childLeft += subtreeWidth(cid) + gapX;
        });
        const childPositions = childIds.map(cid => positions.get(cid)).filter(Boolean);
        if (childPositions.length) {
          const leftCenter = Math.min(...childPositions.map(pos => pos.x + cardW / 2));
          const rightCenter = Math.max(...childPositions.map(pos => pos.x + cardW / 2));
          x = (leftCenter + rightCenter) / 2 - cardW / 2;
        } else {
          x = left + (width - cardW) / 2;
        }
      }

      // Center the primary person within the couple's reserved width and place
      // the spouse immediately beside them at the same generation.
      if (spouseOnlyByPartner.has(personId)) {
        const spouseId = spouseOnlyByPartner.get(personId);
        const coupleWidth = cardW * 2 + gapX;
        // Leaf placement already computes the left edge of the couple's reserved
        // slot. For parents with descendants, x is the primary card's centered
        // position, so center the couple around that position instead.
        const coupleLeft = childIds.length
          ? x + cardW / 2 - coupleWidth / 2
          : x;
        positions.set(personId, { x: coupleLeft, y, depth: d });
        positions.set(spouseId, { x: coupleLeft + cardW + gapX, y, depth: d });
        placed.add(personId);
        placed.add(spouseId);
      } else {
        positions.set(personId, { x, y, depth: d });
        placed.add(personId);
      }
    }

    roots.forEach(root => {
      const width = subtreeWidth(root.id);
      placeSubtree(root.id, rootLeft, 0);
      rootLeft += width + gapX * 2;
    });

    // Defensive fallback for malformed/cyclic/disconnected records so no card disappears.
    list.filter(p => !placed.has(p.id))
      .sort((a, b) => idCollator.compare(a.id, b.id))
      .forEach(p => {
        const d = depthMemo.get(p.id) || 0;
        const x = rootLeft;
        positions.set(p.id, { x, y: pad + d * (cardH + gapY), depth: d });
        rootLeft += cardW + gapX;
      });

    // Normalize the tree to leave padding at the left edge.
    const minX = Math.min(0, ...[...positions.values()].map(pos => pos.x - pad));
    if (minX < 0) positions.forEach(pos => { pos.x -= minX; });

    const maxX = Math.max(1000, ...[...positions.values()].map(pos => pos.x + cardW + pad));
    const maxY = Math.max(700, ...[...positions.values()].map(pos => pos.y + cardH + pad + 48));
    stage.style.width = maxX + "px";
    stage.style.height = maxY + "px";
    svg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
  }

  function edgePath(a,b,spouse=false) {
    const x1=a.x+cardW/2, y1=a.y+cardH, x2=b.x+cardW/2, y2=b.y;
    if(spouse) return `<path class="edge spouse" d="M ${a.x+cardW} ${a.y+cardH/2} C ${a.x+cardW+18} ${a.y+cardH/2}, ${b.x-18} ${b.y+cardH/2}, ${b.x} ${b.y+cardH/2}"/>`;
    const mid=y1+(y2-y1)/2;
    return `<path class="edge" d="M ${x1} ${y1} V ${mid} H ${x2} V ${y2}"/>`;
  }
  function renderGenerationBands(list) {
    if (!generationBands) return;
    generationBands.innerHTML = "";
    if (!positions.size) return;
    const maxDepth = Math.max(0, ...[...positions.values()].map(pos => pos.depth || 0));
    const width = parseFloat(stage.style.width) || 1000;
    const palette = [
      { bg: "#f1f5eb", border: "#e0e8d8", label: "#607557" },
      { bg: "#edf3f8", border: "#dce7f0", label: "#56718a" },
      { bg: "#f8f0e5", border: "#eee1ca", label: "#8a7045" },
      { bg: "#f6edf3", border: "#eadbe6", label: "#8a637d" },
      { bg: "#edf4f2", border: "#d8e8e2", label: "#547b70" },
      { bg: "#f4f0fa", border: "#e3daf1", label: "#75648d" }
    ];
    for (let depth = 0; depth <= maxDepth; depth++) {
      const rowY = pad + depth * (cardH + gapY);
      const color = palette[depth % palette.length];
      const band = document.createElement("div");
      band.className = "generation-band";
      band.style.left = "0px";
      band.style.top = (rowY - 16) + "px";
      band.style.width = width + "px";
      band.style.height = (cardH + 56) + "px";
      band.style.background = color.bg;
      band.style.borderColor = color.border;
      band.style.setProperty("--generation-label-color", color.label);
      band.innerHTML = `<span class="generation-band-label">GENERATION ${depth + 1}</span>`;
      generationBands.appendChild(band);
    }
  }

  function render() {
    const list=visiblePeople(); assignPositions(list); nodes.innerHTML=""; svg.innerHTML="";
    renderGenerationBands(list);
    const listIds=new Set(list.map(p=>p.id));
    const currentSpousePairs=spousePairs(list).filter(pair => {
      const a=positions.get(pair.a), b=positions.get(pair.b);
      return a && b && a.depth===b.depth;
    });
    const pairedIds=new Set(currentSpousePairs.flatMap(pair => [pair.a,pair.b]));

    // Draw one shared outer box per couple. Individual cards remain clickable and
    // the spouse connector is still rendered by the SVG below.
    currentSpousePairs.forEach(pair => {
      const a=positions.get(pair.a), b=positions.get(pair.b);
      const left=Math.min(a.x,b.x)-14;
      const top=Math.min(a.y,b.y)-12;
      const right=Math.max(a.x,b.x)+cardW+14;
      const bottom=Math.max(a.y,b.y)+cardH+40;
      const box=document.createElement("div");
      box.className="couple-group";
      box.style.left=left+"px";
      box.style.top=top+"px";
      box.style.width=(right-left)+"px";
      box.style.height=(bottom-top)+"px";
      box.setAttribute("aria-label","Couple and shared children");
      const partner=byId.get(pair.a);
      box.innerHTML=`<div class="couple-children-count">${safe(childrenCounts(partner,list))}</div>`;
      nodes.appendChild(box);
    });

    list.forEach(p=>{
      const pos=positions.get(p.id), card=document.createElement("button");
      card.type="button";
      card.className="person-card person-card--"+cardType(p,list)+(pairedIds.has(p.id)?" person-card--paired":"");
      card.dataset.id=p.id;card.setAttribute("aria-label",`Open profile for ${p.fullName}`);
      card.style.left=pos.x+"px";card.style.top=pos.y+"px";
      const individualCount=pairedIds.has(p.id)?"":`<div class="children-count">${safe(childrenCounts(p,list))}</div>`;
      const mainTagline = branchTagline(p);
      const taglineHtml = mainTagline ? `<div class="branch-tagline"><span>${safe(mainTagline.english)} (${safe(mainTagline.telugu)})</span><small>${safe(mainTagline.meaning)}</small></div>` : "";
      card.innerHTML=`${personAvatar(p)}<div class="name">${safe(p.fullName)}</div>${p.teluguName?`<div class="telugu-name" lang="te">${safe(p.teluguName)}</div>`:""}${taglineHtml}${individualCount}<div class="role">${safe(p.role||"Family member")}</div><div class="years">${safe(year(p.birthDate))}${p.deathDate?" – "+safe(year(p.deathDate)):""}</div>`;
      card.addEventListener("click",()=>openProfile(p.id));nodes.appendChild(card);
    });
    // Parent-child connections; shared children connect to a midpoint between known parents.
    list.forEach(child=>{
      const childPos=positions.get(child.id); if(!childPos)return;
      const parents=(child.parentIds||[]).filter(id=>listIds.has(id)&&positions.has(id));
      if(!parents.length)return;
      const parentPos=parents.map(id=>({id,...positions.get(id)}));
      if(parentPos.length===1) svg.insertAdjacentHTML("beforeend",edgePath(parentPos[0],childPos));
      else {
        const centers=parentPos.map(p=>p.x+cardW/2), y=parentPos[0].y+cardH/2;
        const top=parentPos[0].y+cardH, childX=childPos.x+cardW/2, junctionY=top+gapY/2;
        // Connect each parent card to a shared junction and down to the child.
        parentPos.forEach(p=>svg.insertAdjacentHTML("beforeend",`<path class="edge" d="M ${p.x+cardW/2} ${p.y+cardH} V ${junctionY}"/>`));
        const min=Math.min(...centers),max=Math.max(...centers);
        svg.insertAdjacentHTML("beforeend",`<path class="edge" d="M ${min} ${junctionY} H ${max} M ${(min+max)/2} ${junctionY} V ${childPos.y} H ${childX} V ${childPos.y}"/>`);
      }
    });
    spousePairs(list).forEach(pair=>{
      const a=positions.get(pair.a),b=positions.get(pair.b); if(a&&b&&a.depth===b.depth) svg.insertAdjacentHTML("beforeend",edgePath(a,b,true));
    });
    empty.hidden=list.length>0;
    applyTransform();
    if (!hasInitialCentered && list.length) {
      const roots = list.filter(p => !(p.parentIds || []).some(id => listIds.has(id)));
      if (roots.length) {
        centerOn(roots[0].id);
        hasInitialCentered = true;
      }
    }
    if(activeId&&positions.has(activeId)) highlight(activeId,false);
  }
  function applyTransform(){stage.style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;}
  function updateHighlight(id) {
    activeId = id;
    document.querySelectorAll(".person-card").forEach(el => {
      el.classList.toggle("highlight", el.dataset.id === id);
    });
  }
  function centerOn(id) {
    const p = positions.get(id);
    if (!p) return;
    scale = Math.min(1.1, Math.max(.55, scale));
    tx = viewport.clientWidth / 2 - (p.x + cardW / 2) * scale;
    ty = viewport.clientHeight / 2 - (p.y + cardH / 2) * scale;
    applyTransform();
    // Do not call highlight() here: highlight() can call centerOn().
    // Updating the visual selection directly avoids infinite recursion.
    updateHighlight(id);
  }
  function highlight(id, scroll = true) {
    updateHighlight(id);
    if (scroll) centerOn(id);
  }
  function openProfile(id) {
    const p=byId.get(id);if(!p)return;lastFocus=document.activeElement;activeId=id;
    const relatives=(ids,label)=>ids.filter(rid=>byId.has(rid)).map(rid=>`<button class="relative-link" data-relative="${safe(rid)}">${safe(byId.get(rid).fullName)}<small>${safe(label)}</small></button>`).join("");
    const parents=relatives(p.parentIds||[],"Parent");
    const spouses=relatives(p.spouseIds||[],"Spouse / partner");
    const children=relatives(people.filter(c=>(c.parentIds||[]).includes(id)).map(c=>c.id),"Child");
    const siblings=relatives(people.filter(s=>s.id!==id&&(s.parentIds||[]).some(pid=>(p.parentIds||[]).includes(pid))&&(p.parentIds||[]).length).map(s=>s.id),"Sibling");
    profileContent.innerHTML=`<div class="profile-hero">${personAvatar(p,true)}<h2 id="profileName">${safe(p.fullName)}</h2><p>${safe(p.role||"Family member")}</p></div>
      <div class="profile-section"><h3>Personal details</h3><div class="detail-grid">
      <div><span class="detail-label">Date of birth</span><span class="detail-value">${safe(formatDate(p.birthDate)||"Not provided")}</span></div>
      <div><span class="detail-label">Date of death</span><span class="detail-value">${safe(formatDate(p.deathDate)||"—")}</span></div>
      <div><span class="detail-label">Occupation</span><span class="detail-value">${safe(p.occupation||"Not provided")}</span></div>
      <div><span class="detail-label">Hometown</span><span class="detail-value">${safe(p.hometown||"Not provided")}</span></div></div></div>
      ${p.biography?`<div class="profile-section"><h3>Story</h3><p>${safe(p.biography)}</p></div>`:""}
      ${parents?`<div class="profile-section"><h3>Parents</h3>${parents}</div>`:""}
      ${spouses?`<div class="profile-section"><h3>Spouse / partner</h3>${spouses}</div>`:""}
      ${children?`<div class="profile-section"><h3>Children</h3>${children}</div>`:""}
      ${siblings?`<div class="profile-section"><h3>Siblings</h3>${siblings}</div>`:""}
      ${p.notes?`<div class="profile-section"><h3>Notes</h3><p>${safe(p.notes)}</p></div>`:""}`;
    panel.hidden=false;backdrop.hidden=false;document.body.style.overflow="hidden";document.getElementById("closeProfile").focus();
    profileContent.querySelectorAll("[data-relative]").forEach(btn=>btn.addEventListener("click",()=>openProfile(btn.dataset.relative)));
  }
  function closeProfile(){panel.hidden=true;backdrop.hidden=true;document.body.style.overflow="";if(lastFocus&&lastFocus.focus)lastFocus.focus();}
  document.getElementById("closeProfile").addEventListener("click",closeProfile);backdrop.addEventListener("click",closeProfile);
  document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!panel.hidden)closeProfile();if(e.key==="Escape"&&!searchResults.hidden){searchResults.hidden=true;search.blur();}});
  search.addEventListener("input",()=>{
    const q=search.value.trim().toLocaleLowerCase();searchResults.innerHTML="";
    if(!q){searchResults.hidden=true;return;}
    const matches=people.filter(p=>p.fullName.toLocaleLowerCase().includes(q)).slice(0,12);
    matches.forEach(p=>{const b=document.createElement("button");b.className="search-result";b.type="button";b.setAttribute("role","option");b.innerHTML=`${safe(p.fullName)}<small>${safe(p.role||"Family member")}</small>`;b.addEventListener("click",()=>{filter.value="all";mainFilter.value="";populateMainBranches();render();search.value=p.fullName;searchResults.hidden=true;centerOn(p.id);});searchResults.appendChild(b);});
    if(!matches.length)searchResults.innerHTML='<div class="search-result">No matching family members</div>';
    searchResults.hidden=false;
  });
  document.addEventListener("click",e=>{if(!e.target.closest(".search-wrap"))searchResults.hidden=true;});
  filter.addEventListener("change",()=>{
    mainFilter.value = "";
    populateMainBranches();
    render();
    reset();
  });
  mainFilter.addEventListener("change",()=>{
    const selected = byId.get(mainFilter.value);
    if (selected) {
      const side = branchOfPerson(selected.id);
      if (side) filter.value = side;
      populateMainBranches();
      mainFilter.value = selected.id;
    }
    render();
    reset();
  });
  document.getElementById("zoomIn").addEventListener("click",()=>{scale=Math.min(1.7,scale+.12);applyTransform();});
  document.getElementById("zoomOut").addEventListener("click",()=>{scale=Math.max(.35,scale-.12);applyTransform();});
  function reset(){scale=.85;tx=35;ty=35;applyTransform();}
  document.getElementById("resetView").addEventListener("click",reset);
  document.getElementById("homeView").addEventListener("click",()=>{filter.value="all";mainFilter.value="";populateMainBranches();search.value="";searchResults.hidden=true;render();reset();});
  document.getElementById("exploreBtn").addEventListener("click",()=>document.getElementById("family").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"}));
  // Panning should behave like a canvas: empty space drags, cards remain clickable.
  // Disable native text selection during a pan so labels never get highlighted.
  viewport.style.userSelect = "none";
  viewport.style.webkitUserSelect = "none";
  stage.style.userSelect = "none";
  stage.style.webkitUserSelect = "none";
  viewport.style.cursor = "grab";
  viewport.addEventListener("pointerdown",e=>{
    if(e.target.closest(".person-card")) return;
    e.preventDefault();
    drag={x:e.clientX,y:e.clientY,tx,ty};
    viewport.classList.add("dragging");
    viewport.style.cursor="grabbing";
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener("pointermove",e=>{if(!drag)return;tx=drag.tx+e.clientX-drag.x;ty=drag.ty+e.clientY-drag.y;applyTransform();});
  function endDrag(){drag=null;viewport.classList.remove("dragging");viewport.style.cursor="grab";}
  viewport.addEventListener("pointerup",endDrag);viewport.addEventListener("pointercancel",endDrag);
  viewport.addEventListener("wheel",e=>{if(!e.ctrlKey)return;e.preventDefault();scale=Math.max(.35,Math.min(1.7,scale+(e.deltaY<0?.06:-.06)));applyTransform();},{passive:false});
  window.addEventListener("resize",()=>{if(activeId&&positions.has(activeId))centerOn(activeId);});

  // Reliable vector PDF export. Draw directly with jsPDF instead of converting a
  // giant SVG (which caused "Maximum call stack size exceeded" in Chrome).
  const printButton = document.getElementById("printPdfBtn");

  function loadScriptOnce(src, globalCheck) {
    if (globalCheck()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find(s => s.src === src);
      if (existing) {
        if (existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.onload = () => { script.dataset.loaded = "true"; resolve(); };
      script.onerror = () => reject(new Error("Could not load the PDF library. Check your internet connection."));
      document.head.appendChild(script);
    });
  }

  async function ensurePdfLibrary() {
    await loadScriptOnce(
      "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
      () => !!(window.jspdf && window.jspdf.jsPDF)
    );
    if (!(window.jspdf && window.jspdf.jsPDF)) throw new Error("The PDF library did not initialize.");
  }

  function pdfPalette(type) {
    if (type === "female") return { fill: "#fff8fc", border: "#e8c4d8", avatar: "#f6e3ed", ink: "#8b456a", count: "#925a78" };
    if (type === "spouse") return { fill: "#fff9eb", border: "#dfbd65", avatar: "#f4e4b8", ink: "#78591c", count: "#866a2b" };
    if (type === "male") return { fill: "#fffefa", border: "#c9d9eb", avatar: "#e5edf7", ink: "#365b84", count: "#456783" };
    return { fill: "#fffefa", border: "#d8dfd2", avatar: "#e9eee3", ink: "#45634a", count: "#526b57" };
  }

  function hexRgb(hex) {
    const v = String(hex).replace("#", "");
    return [parseInt(v.slice(0,2),16), parseInt(v.slice(2,4),16), parseInt(v.slice(4,6),16)];
  }

  function exportFullTreePdf() {
    if (!printButton || printButton.dataset.busy === "1") return;
    printButton.dataset.busy = "1";
    const originalLabel = printButton.textContent;
    const originalFilter = filter.value;
    const originalMainFilter = mainFilter.value;
    const selectedPerson = byId.get(originalMainFilter);
    const originalScale = scale, originalTx = tx, originalTy = ty;
    printButton.textContent = "Preparing PDF…";
    printButton.disabled = true;

    (async () => {
      try {
        // Export exactly the view currently shown: full tree, side, or selected main branch.
        render();
        await ensurePdfLibrary();
        if (document.fonts && document.fonts.load) await document.fonts.load('400 78px Ponnala', 'తెలుగు');
        const { jsPDF } = window.jspdf;
        const margin = 26;
        const width = Math.max(1000, parseFloat(stage.style.width) || 1000);
        const height = Math.max(700, parseFloat(stage.style.height) || 700);
        const list = visiblePeople();
        if (!list.length) throw new Error("There are no family members in the selected branch to export.");

        // Selected p2/p3/p4 branches use ONE custom-size landscape page.
        // Full-tree exports retain the A3 overview + readable tile workflow.
        const singlePageBranch = Boolean(selectedPerson);
        const branchPageScale = 0.58;
        const pdfHeaderSpace = 145;
        const pdfFooterSpace = 150;
        const pageFormat = singlePageBranch
          ? [Math.max(800, width * branchPageScale + margin * 2),
             Math.max(700, height * branchPageScale + margin * 2 + pdfHeaderSpace + pdfFooterSpace)]
          : "a3";
        const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: pageFormat, compress: true, putOnlyUsedFonts: true });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const contentW = pageW - margin * 2;
        const contentH = pageH - margin * 2 - pdfHeaderSpace - pdfFooterSpace;
        const exportTitle = selectedPerson
          ? `FAMILY TREE — ${String(selectedPerson.fullName || selectedPerson.id).toUpperCase()} BRANCH (${selectedPerson.id})`
          : filter.value === "paternal" ? "FAMILY TREE — PATERNAL BRANCH"
          : filter.value === "maternal" ? "FAMILY TREE — MATERNAL BRANCH"
          : "FAMILY TREE — COMPLETE OVERVIEW";

        // Polished, branded PDF header with a highlighted branch label.
        function makeHeaderImage() {
          const canvas = document.createElement("canvas");
          canvas.width = 1800;
          canvas.height = 250;
          const ctx = canvas.getContext("2d");
          const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          bg.addColorStop(0, "#f8f6ed");
          bg.addColorStop(0.55, "#edf2e7");
          bg.addColorStop(1, "#e1e9da");
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          // Decorative fine borders and corner flourishes.
          ctx.strokeStyle = "#b89a55";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(70, 18); ctx.lineTo(canvas.width - 70, 18);
          ctx.moveTo(70, canvas.height - 18); ctx.lineTo(canvas.width - 70, canvas.height - 18);
          ctx.stroke();
          ctx.fillStyle = "#b89a55";
          for (const x of [70, canvas.width - 70]) {
            ctx.beginPath(); ctx.arc(x, 18, 5, 0, Math.PI * 2); ctx.fill();
            ctx.beginPath(); ctx.arc(x, canvas.height - 18, 5, 0, Math.PI * 2); ctx.fill();
          }

          ctx.textAlign = "center";
          ctx.fillStyle = "#526b58";
          ctx.font = "bold 20px Arial, sans-serif";
          ctx.fillText("OUR FAMILY HERITAGE", canvas.width / 2, 52);

          ctx.fillStyle = "#26382e";
          ctx.font = "bold 58px Georgia, 'Noto Serif', serif";
          ctx.fillText("Thoom's Family Tree", canvas.width / 2, 112);

          ctx.fillStyle = "#526b58";
          ctx.font = "27px Georgia, 'Noto Serif', serif";
          ctx.fillText("The Family Heritage of the Thoom Patels", canvas.width / 2, 151);

          const selectedTagline = selectedPerson ? branchTagline(selectedPerson) : null;
          if (selectedTagline) {
            const label = `${selectedTagline.english} (${selectedTagline.telugu})`;
            ctx.font = "bold 27px Arial, 'Noto Sans Telugu', Gautami, sans-serif";
            const badgeW = Math.min(1000, ctx.measureText(label).width + 100);
            const badgeX = (canvas.width - badgeW) / 2;
            ctx.fillStyle = "#dce7d5";
            ctx.beginPath();
            ctx.roundRect(badgeX, 174, badgeW, 48, 24);
            ctx.fill();
            ctx.strokeStyle = "#b6c8a9";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = "#354f3d";
            ctx.fillText(label, canvas.width / 2, 207);
          } else {
            const legend = [
              { x: 350, text: "Peddollu (పెద్దోళ్ళు)" },
              { x: 900, text: "Nadipollu (నడిపోళ్లు)" },
              { x: 1450, text: "Chinnollu (చిన్నోళ్లు)" }
            ];
            ctx.font = "bold 23px Arial, 'Noto Sans Telugu', Gautami, sans-serif";
            legend.forEach(item => {
              const w = Math.min(500, ctx.measureText(item.text).width + 44);
              ctx.fillStyle = "#dce7d5";
              ctx.beginPath();
              ctx.roundRect(item.x - w / 2, 177, w, 42, 21);
              ctx.fill();
              ctx.fillStyle = "#354f3d";
              ctx.fillText(item.text, item.x, 205);
            });
          }
          return canvas.toDataURL("image/png");
        }

        // A compact, borderless footer. Fixed line breaks prevent any clipping
        // when English and Telugu fonts have different text-measurement metrics.
        function makeDisclaimerImage() {
          const canvas = document.createElement("canvas");
          canvas.width = 1800;
          canvas.height = 250;
          const ctx = canvas.getContext("2d");
          const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
          bg.addColorStop(0, "#fbfaf5");
          bg.addColorStop(1, "#f1f4eb");
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = "#b89a55";
          ctx.fillRect(80, 14, canvas.width - 160, 3);
          ctx.textAlign = "center";
          ctx.fillStyle = "#405344";
          ctx.font = "bold 29px Arial, 'Noto Sans Telugu', Gautami, sans-serif";
          ctx.fillText("DISCLAIMER / గమనిక", canvas.width / 2, 49);

          ctx.fillStyle = "#4f5f52";
          ctx.font = "21px Arial, sans-serif";
          ctx.fillText("Information in this family tree was collected from various sources; some details may need correction.", canvas.width / 2, 83);
          ctx.fillText("Please forgive any mistakes and let us know so we can correct them. Contact Pranay Kumar on WhatsApp: +91-970197XXXX.", canvas.width / 2, 111);

          ctx.font = "21px Arial, 'Noto Sans Telugu', Gautami, sans-serif";
          ctx.fillText("ఈ కుటుంబ వృక్షంలోని సమాచారం వివిధ వనరుల నుండి సేకరించబడింది. కొన్ని వివరాలకు సవరణలు అవసరం కావచ్చు.", canvas.width / 2, 151);
          ctx.fillText("ఏవైనా తప్పులు ఉంటే దయచేసి క్షమించి మాకు తెలియజేయండి. సవరణల కోసం ప్రణయ్ కుమార్‌ను వాట్సాప్ ద్వారా +91-970197XXXX నంబర్‌లో సంప్రదించండి.", canvas.width / 2, 179);

          ctx.fillStyle = "#6c765f";
          ctx.font = "italic 19px Georgia, serif";
          ctx.fillText("Thank you for helping us preserve our family history.", canvas.width / 2, 216);
          return canvas.toDataURL("image/png");
        }
        const headerImage = makeHeaderImage();
        const disclaimerImage = makeDisclaimerImage();
        const palette = [
          { bg: "#f1f5eb", border: "#e0e8d8", label: "#607557" },
          { bg: "#edf3f8", border: "#dce7f0", label: "#56718a" },
          { bg: "#f8f0e5", border: "#eee1ca", label: "#8a7045" },
          { bg: "#f6edf3", border: "#eadbe6", label: "#8a637d" },
          { bg: "#edf4f2", border: "#d8e8e2", label: "#547b70" },
          { bg: "#f4f0fa", border: "#e3daf1", label: "#75648d" }
        ];
        const maxDepth = Math.max(0, ...Array.from(positions.values(), p => p.depth || 0));
        const pairs = spousePairs(list).filter(pair => {
          const a = positions.get(pair.a), b = positions.get(pair.b);
          return a && b && a.depth === b.depth;
        });
        const pairedIds = new Set(pairs.flatMap(pair => [pair.a, pair.b]));
        const pairById = new Map();
        pairs.forEach(pair => { pairById.set(pair.a, pair); pairById.set(pair.b, pair); });

        // Direct vector drawing: no SVG serialization, recursive conversion, or giant canvas.
        function drawPage(viewX, viewY, viewW, viewH, heading, overview) {
          const scaleFactor = Math.min(contentW / viewW, contentH / viewH);
          const drawnW = viewW * scaleFactor, drawnH = viewH * scaleFactor;
          const offsetX = margin + (contentW - drawnW) / 2;
          const offsetY = margin + pdfHeaderSpace + (contentH - drawnH) / 2;
          const X = x => offsetX + (x - viewX) * scaleFactor;
          const Y = y => offsetY + (y - viewY) * scaleFactor;
          const S = n => n * scaleFactor;
          const inside = (x, y, w, h) => x + w >= viewX && x <= viewX + viewW && y + h >= viewY && y <= viewY + viewH;
        // Avoid printing half-cards or half-couple boxes at tile boundaries. The
        // neighbouring page has generous overlap and will contain the full card.
        const fullyInside = (x, y, w, h) => x >= viewX - 0.1 && y >= viewY - 0.1 &&
          x + w <= viewX + viewW + 0.1 && y + h <= viewY + viewH + 0.1;
          doc.setFillColor(251, 250, 245);
          doc.rect(margin, margin + pdfHeaderSpace, contentW, contentH, "F");
          const headerW = Math.min(1000, pageW - margin * 2);
          const headerH = headerW * (250 / 1800);
          doc.addImage(headerImage, "PNG", (pageW - headerW) / 2, 3, headerW, headerH, undefined, "FAST");

          // Generation background bands and labels.
          for (let depth = 0; depth <= maxDepth; depth++) {
            const y = pad + depth * (cardH + gapY) - 16;
            const h = cardH + 56;
            if (!inside(0, y, width, h)) continue;
            const c = palette[depth % palette.length];
            const bg = hexRgb(c.bg), br = hexRgb(c.border);
            doc.setFillColor(...bg); doc.setDrawColor(...br); doc.setLineWidth(Math.max(0.4, S(1)));
            doc.roundedRect(X(0), Y(y), S(width), S(h), S(14), S(14), "FD");
            if (S(10) >= 4) {
              doc.setTextColor(...hexRgb(c.label)); doc.setFont("helvetica", "bold"); doc.setFontSize(Math.max(4, S(10)));
              doc.text(`GENERATION ${depth + 1}`, X(12), Y(y + 13));
            }
          }

          // Couple outer boxes, including the shared child count at the bottom.
          pairs.forEach(pair => {
            const a = positions.get(pair.a), b = positions.get(pair.b);
            if (!a || !b) return;
            const left = Math.min(a.x, b.x) - 14;
            const top = Math.min(a.y, b.y) - 12;
            const right = Math.max(a.x, b.x) + cardW + 14;
            const bottom = Math.max(a.y, b.y) + cardH + 40;
            if (!fullyInside(left, top, right-left, bottom-top)) return;
            doc.setFillColor(255, 253, 246); doc.setDrawColor(199, 173, 105); doc.setLineWidth(Math.max(0.5, S(1.5)));
            doc.roundedRect(X(left), Y(top), S(right-left), S(bottom-top), S(17), S(17), "FD");
            doc.setTextColor(120, 95, 37); doc.setFont("helvetica", "bold"); doc.setFontSize(Math.max(4, S(11)));
            doc.text(childrenCounts(byId.get(pair.a), list), X((left+right)/2), Y(bottom-11), { align: "center", maxWidth: S(right-left-12) });
          });

          // Parent-child connectors. Each is built from short line segments.
          doc.setDrawColor(184, 199, 177); doc.setLineWidth(Math.max(0.45, S(2.2)));
          list.forEach(child => {
            const cp = positions.get(child.id); if (!cp) return;
            const parents = (child.parentIds || []).filter(id => positions.has(id) && byId.has(id));
            if (!parents.length) return;
            const childX = cp.x + cardW/2;
            if (parents.length === 1) {
              const pp = positions.get(parents[0]);
              const x1 = pp.x + cardW/2, y1 = pp.y + cardH, y2 = cp.y, mid = y1 + (y2-y1)/2;
              doc.line(X(x1), Y(y1), X(x1), Y(mid));
              doc.line(X(x1), Y(mid), X(childX), Y(mid));
              doc.line(X(childX), Y(mid), X(childX), Y(y2));
            } else {
              const ps = parents.map(id => positions.get(id)).filter(Boolean);
              if (!ps.length) return;
              const junctionY = ps[0].y + cardH + gapY/2;
              const centers = ps.map(p => p.x + cardW/2);
              ps.forEach(p => doc.line(X(p.x+cardW/2), Y(p.y+cardH), X(p.x+cardW/2), Y(junctionY)));
              const minX = Math.min(...centers), maxX = Math.max(...centers), midX = (minX+maxX)/2;
              doc.line(X(minX), Y(junctionY), X(maxX), Y(junctionY));
              doc.line(X(midX), Y(junctionY), X(midX), Y(cp.y));
              doc.line(X(midX), Y(cp.y), X(childX), Y(cp.y));
              doc.line(X(childX), Y(cp.y), X(childX), Y(cp.y));
            }
          });

          // Spouse connectors use a dashed gold line.
          pairs.forEach(pair => {
            const a = positions.get(pair.a), b = positions.get(pair.b);
            if (!a || !b) return;
            const left = a.x <= b.x ? a : b, right = a.x <= b.x ? b : a;
            const x1 = left.x + cardW, x2 = right.x, y = left.y + cardH/2;
            doc.setDrawColor(213, 183, 94); doc.setLineWidth(Math.max(0.45, S(2)));
            const dash = Math.max(2, S(5)), gap = Math.max(1.5, S(4));
            for (let xx = X(x1); xx < X(x2); xx += dash + gap) doc.line(xx, Y(y), Math.min(X(x2), xx + dash), Y(y));
          });

          // Person cards and all relevant labels.
          list.forEach(person => {
            const pos = positions.get(person.id); if (!pos) return;
            if (!fullyInside(pos.x, pos.y, cardW, cardH)) return;
            const el = nodes.querySelector(`.person-card[data-id="${CSS.escape(person.id)}"]`);
            const type = el ? (["male", "female", "spouse", "unknown"].find(t => el.classList.contains("person-card--" + t)) || cardType(person, list)) : cardType(person, list);
            const c = pdfPalette(type), fill = hexRgb(c.fill), border = hexRgb(c.border), avatar = hexRgb(c.avatar);
            const x = X(pos.x), y = Y(pos.y), w = S(cardW), h = S(cardH);
            doc.setFillColor(...fill); doc.setDrawColor(...border); doc.setLineWidth(Math.max(0.45, S(1.4)));
            doc.roundedRect(x, y, w, h, S(12), S(12), "FD");
            doc.setFillColor(...avatar); doc.setDrawColor(245, 242, 232);
            doc.circle(X(pos.x + cardW/2), Y(pos.y + 39), S(27.5), "FD");
            doc.setTextColor(...hexRgb(c.ink)); doc.setFont("times", "normal"); doc.setFontSize(Math.max(4, S(15)));
            doc.text(initials(person.fullName), X(pos.x + cardW/2), Y(pos.y + 44), { align: "center" });
            doc.setTextColor(31, 42, 35); doc.setFont("helvetica", "bold"); doc.setFontSize(Math.max(4, S(12.5)));
            doc.text(String(person.fullName || ""), X(pos.x + cardW/2), Y(pos.y + 78), { align: "center", maxWidth: w - S(10) });
            const hasTeluguName = Boolean(person.teluguName && String(person.teluguName).trim());
            if (hasTeluguName) {
              // Canvas rendering uses the Ponnala webfont so Telugu shaping remains correct in exported PDFs.
              const teluguCanvas = document.createElement("canvas");
              // Taller high-resolution canvas plus a larger destination box prevents
              // Telugu glyphs from shrinking compared with the English name in PDF.
              // IMPORTANT: Keep the source canvas and PDF destination at the same
              // aspect ratio. The previous mismatch (1600x112 drawn into 140x25)
              // vertically stretched the Telugu glyphs and made them look distorted.
              // This canvas is proportioned to the destination box to preserve glyphs.
              teluguCanvas.width = 1600;
              // Extra vertical padding prevents tall Telugu vowel marks and
              // diacritics from being clipped by the top edge of the canvas.
              // Keep the source and PDF destination aspect ratios matched.
              teluguCanvas.height = 260; // ratio 1600:260 matches 140:22.75
              const teluguCtx = teluguCanvas.getContext("2d");
              teluguCtx.clearRect(0, 0, teluguCanvas.width, teluguCanvas.height);
              teluguCtx.textAlign = "center";
              teluguCtx.textBaseline = "alphabetic";
              teluguCtx.fillStyle = "#1f2a23";
              teluguCtx.font = "400 150px Ponnala, sans-serif";
              // Draw lower than the top edge so all Telugu marks fit.
              teluguCtx.fillText(String(person.teluguName), teluguCanvas.width / 2, 178, 1520);
              // Matching aspect ratio keeps glyphs undistorted; extra height
              // leaves room for tall marks without clipping them.
              doc.addImage(teluguCanvas.toDataURL("image/png"), "PNG", X(pos.x + 8), Y(pos.y + 82), S(cardW - 16), S(22.75), undefined, "FAST");
            }
            const personTagline = branchTagline(person);
            const textOffset = (hasTeluguName ? 27 : 0) + (personTagline ? 13 : 0);
            if (personTagline) {
              const taglineCanvas = document.createElement("canvas");
              taglineCanvas.width = 900;
              taglineCanvas.height = 72;
              const taglineCtx = taglineCanvas.getContext("2d");
              taglineCtx.clearRect(0, 0, taglineCanvas.width, taglineCanvas.height);
              taglineCtx.textAlign = "center";
              taglineCtx.fillStyle = "#526b58";
              taglineCtx.font = "bold 31px Arial, 'Noto Sans Telugu', Gautami, sans-serif";
              taglineCtx.fillText(`${personTagline.english} (${personTagline.telugu})`, 450, 31);
              taglineCtx.fillStyle = "#6c765f";
              taglineCtx.font = "27px Arial, sans-serif";
              taglineCtx.fillText(personTagline.meaning, 450, 62);
              doc.addImage(taglineCanvas.toDataURL("image/png"), "PNG", X(pos.x + 8), Y(pos.y + (hasTeluguName ? 110 : 82)), S(cardW - 16), S(13), undefined, "FAST");
            }
            if (!pairedIds.has(person.id)) {
              doc.setTextColor(...hexRgb(c.count)); doc.setFont("helvetica", "bold"); doc.setFontSize(Math.max(3.5, S(9.4)));
              doc.text(childrenCounts(person, list), X(pos.x + cardW/2), Y(pos.y + 92 + textOffset), { align: "center", maxWidth: w - S(8) });
            }
            doc.setTextColor(104, 119, 108); doc.setFont("helvetica", "normal"); doc.setFontSize(Math.max(3.5, S(10.4)));
            doc.text(String(person.role || "Family member"), X(pos.x + cardW/2), Y(pos.y + (pairedIds.has(person.id) ? 105 : 107) + textOffset), { align: "center", maxWidth: w - S(8) });
            const dates = person.birthDate ? year(person.birthDate) + (person.deathDate ? " – " + year(person.deathDate) : "") : (person.deathDate ? year(person.deathDate) : "");
            if (dates) {
              doc.setTextColor(140, 128, 93); doc.setFontSize(Math.max(3.5, S(9.6)));
              doc.text(dates, X(pos.x + cardW/2), Y(pos.y + 122 + textOffset), { align: "center", maxWidth: w - S(8) });
            }
          });

          // Disclaimer is printed on every exported page, including each full-tree tile.
          const disclaimerW = Math.min(1000, pageW - margin * 2);
          const disclaimerH = disclaimerW * (250 / 1800);
          const disclaimerX = (pageW - disclaimerW) / 2;
          const footerY = pageH - disclaimerH - 5;
          // Center the compact footer without a separate outline or divider.
          doc.addImage(disclaimerImage, "PNG", disclaimerX, footerY, disclaimerW, disclaimerH, undefined, "FAST");
        }

        // Detail tiles overlap by 22%, enough to repeat complete person/couple
        // cards at page edges and make adjacent sheets easy to align.
        const detailW = Math.min(width, 2050);
        const detailH = Math.min(height, detailW * contentH / contentW);
        const stepX = Math.max(1, detailW * 0.78), stepY = Math.max(1, detailH * 0.78);
        const cols = Math.max(1, Math.ceil(Math.max(0, width - detailW) / stepX) + 1);
        const rows = Math.max(1, Math.ceil(Math.max(0, height - detailH) / stepY) + 1);
        const totalPages = rows * cols + 1;

        // A small grid locator is printed on every page. On detail pages, the
        // active cell is highlighted and the title identifies its row/column.
        function drawTileLocator(activeRow = -1, activeCol = -1) {
          const cellW = 8, cellH = 6, gap = 1;
          const mapW = cols * (cellW + gap) - gap;
          const mapH = rows * (cellH + gap) - gap;
          const x0 = pageW - margin - mapW;
          const y0 = pageH - 12 - mapH;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(4.5);
          doc.setTextColor(83, 93, 82);
          doc.text("DETAIL PAGE MAP (row × column)", x0, y0 - 3);
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const x = x0 + c * (cellW + gap), y = y0 + r * (cellH + gap);
              const active = r === activeRow && c === activeCol;
              doc.setFillColor(...(active ? [57, 91, 66] : [235, 239, 230]));
              doc.setDrawColor(...(active ? [57, 91, 66] : [184, 197, 178]));
              doc.setLineWidth(0.35);
              doc.rect(x, y, cellW, cellH, "FD");
              if (cols * rows <= 70) {
                doc.setFontSize(3.8);
                doc.setTextColor(...(active ? [255, 255, 255] : [65, 78, 65]));
                doc.text(`${r+1}-${c+1}`, x + cellW / 2, y + 4.2, { align: "center" });
              }
            }
          }
        }

        if (singlePageBranch) {
          // Selected branch: a single custom-size page containing every card.
          drawPage(0, 0, width, height, `${exportTitle} — COMPLETE BRANCH ON ONE PAGE`, false);
        } else {
          // Full tree: locator overview followed by overlapping readable detail tiles.
          drawPage(0, 0, width, height, `${exportTitle} (LOCATOR; USE DETAIL PAGES FOR READABLE NAMES)`, true);
          drawTileLocator();
        }

        if (!singlePageBranch && !(rows === 1 && cols === 1)) {
          let pageNo = 1;
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const vx = Math.min(col * stepX, Math.max(0, width - detailW));
              const vy = Math.min(row * stepY, Math.max(0, height - detailH));
              const neighbours = [];
              if (col > 0) neighbours.push(`left R${row+1}-C${col}`);
              if (col + 1 < cols) neighbours.push(`right R${row+1}-C${col+2}`);
              if (row > 0) neighbours.push(`above R${row}-C${col+1}`);
              if (row + 1 < rows) neighbours.push(`below R${row+2}-C${col+1}`);
              const neighbourText = neighbours.length ? ` · OVERLAPS ${neighbours.join(", ")}` : "";
              doc.addPage("a3", "landscape");
              pageNo++;
              drawPage(vx, vy, detailW, detailH,
                `DETAIL TILE R${row+1}-C${col+1} · PDF PAGE ${pageNo}/${totalPages}${neighbourText}`, false);
              drawTileLocator(row, col);
            }
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }
        const slug = (selectedPerson ? `${selectedPerson.id}-${selectedPerson.fullName || "branch"}` : filter.value === "all" ? "complete-overview-and-details" : `${filter.value}-branch`)
          .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        doc.save(`family-tree-${slug}.pdf`);
      } catch (error) {
        console.error("Family tree PDF export failed:", error);
        alert("The PDF could not be generated. Please try again. Details: " + (error && error.message ? error.message : String(error)));
      } finally {
        filter.value = originalFilter;
        populateMainBranches();
        mainFilter.value = originalMainFilter;
        render();
        scale = originalScale; tx = originalTx; ty = originalTy; applyTransform();
        printButton.textContent = originalLabel;
        printButton.disabled = false;
        delete printButton.dataset.busy;
      }
    })();
  }



  // Mobile-friendly, portrait PDF directory. The original connected-tree PDF
  // export above remains unchanged; this export lists people generation by
  // generation and spells out parents, spouses, and children for easy reading.
  const mobileDirectoryButton = document.getElementById("mobileDirectoryPdfBtn");

  function exportMobileDirectoryPdf() {
    if (!mobileDirectoryButton || mobileDirectoryButton.dataset.busy === "1") return;
    mobileDirectoryButton.dataset.busy = "1";
    const originalLabel = mobileDirectoryButton.textContent;
    mobileDirectoryButton.textContent = "Preparing mobile PDF…";
    mobileDirectoryButton.disabled = true;

    (async () => {
      try {
        await ensurePdfLibrary();
        if (document.fonts && document.fonts.load) {
          await document.fonts.load('400 78px Ponnala', 'తెలుగు');
          await document.fonts.ready;
        }
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true, putOnlyUsedFonts: true });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 34;
        const cardX = margin;
        const cardW = pageW - margin * 2;
        const contentBottom = pageH - 38;
        const cardGap = 10;
        const genMap = new Map();
        const validParentIds = p => (p.parentIds || []).filter(id => id && byId.has(id));
        const validSpouseIds = p => {
          const ids = new Set((p.spouseIds || []).filter(id => id && byId.has(id)));
          people.forEach(other => { if ((other.spouseIds || []).includes(p.id)) ids.add(other.id); });
          ids.delete(p.id);
          return [...ids];
        };

        // Resolve generation from parent links first, then let spouse-only
        // records inherit their partner's generation. No family data is edited.
        people.filter(p => validParentIds(p).length === 0 && validSpouseIds(p).length === 0)
          .forEach(p => genMap.set(p.id, 1));
        people.filter(p => validParentIds(p).length === 0 && p.branch)
          .forEach(p => { if (!genMap.has(p.id)) genMap.set(p.id, 1); });
        for (let pass = 0; pass < people.length + 2; pass++) {
          let changed = false;
          people.forEach(p => {
            const parents = validParentIds(p).map(id => genMap.get(id)).filter(Number.isFinite);
            if (parents.length) {
              const g = Math.max(...parents) + 1;
              if (genMap.get(p.id) !== g) { genMap.set(p.id, g); changed = true; }
            }
          });
          people.forEach(p => {
            if (genMap.has(p.id)) return;
            const partnerGens = validSpouseIds(p).map(id => genMap.get(id)).filter(Number.isFinite);
            if (partnerGens.length) { genMap.set(p.id, Math.min(...partnerGens)); changed = true; }
          });
          if (!changed) break;
        }
        people.forEach(p => { if (!genMap.has(p.id)) genMap.set(p.id, 1); });

        const parentsFor = p => {
          const ids = new Set(validParentIds(p));
          // Some spouse records omit parentIds on purpose; where a recorded
          // parent has a spouse, include that partner as the other parent.
          [...ids].forEach(id => validSpouseIds(byId.get(id)).forEach(sid => ids.add(sid)));
          ids.delete(p.id);
          return [...ids].map(id => byId.get(id)).filter(Boolean);
        };
        const spousesFor = p => validSpouseIds(p).map(id => byId.get(id)).filter(Boolean);
        const childrenFor = p => {
          const parentSet = new Set([p.id, ...spousesFor(p).map(s => s.id)]);
          return people.filter(child => validParentIds(child).some(id => parentSet.has(id)));
        };
        const labelPerson = p => `${p.fullName || p.id} [${p.id}]`;
        const byGeneration = new Map();
        people.forEach((p, index) => {
          const generation = genMap.get(p.id) || 1;
          if (!byGeneration.has(generation)) byGeneration.set(generation, []);
          byGeneration.get(generation).push({ person: p, index });
        });
        [...byGeneration.values()].forEach(group => group.sort((a,b) => a.index - b.index));

        let currentY = 0;
        let currentGeneration = 1;
        let continuation = false;
        let pageIndex = 0;
        function addDirectoryPage(generation, continued = false) {
          if (pageIndex > 0) doc.addPage("a4", "portrait");
          pageIndex++;
          currentGeneration = generation;
          continuation = continued;
          doc.setFillColor(246, 247, 240);
          doc.rect(0, 0, pageW, 88, "F");
          doc.setDrawColor(184, 154, 85);
          doc.setLineWidth(1.2);
          doc.line(margin, 20, pageW - margin, 20);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(15);
          doc.setTextColor(48, 77, 58);
          doc.text("THOOM FAMILY HERITAGE", margin, 43);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8.5);
          doc.setTextColor(90, 103, 89);
          doc.text("MOBILE FAMILY DIRECTORY · PEOPLE AND RELATIONSHIPS", margin, 58);
          doc.setFont("helvetica", "bold");
          doc.setFontSize(12);
          doc.setTextColor(130, 99, 36);
          doc.text(`GENERATION ${generation}${continued ? " · CONTINUED" : ""}`, margin, 78);
          currentY = 102;
        }
        function addPageFooter() {
          doc.setDrawColor(220, 224, 214);
          doc.setLineWidth(0.6);
          doc.line(margin, pageH - 25, pageW - margin, pageH - 25);
          doc.setFont("helvetica", "normal");
          doc.setFontSize(8);
          doc.setTextColor(112, 122, 108);
          doc.text("Family archive · Names and relationships follow family-data.js", margin, pageH - 12);
          doc.text(`${doc.internal.getNumberOfPages()}`, pageW - margin, pageH - 12, { align: "right" });
        }
        function renderTeluguName(name, x, y, width, height) {
          if (!name || !String(name).trim()) return;
          const canvas = document.createElement("canvas");
          canvas.width = 1400;
          canvas.height = 86;
          const ctx = canvas.getContext("2d");
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          ctx.fillStyle = "#1f2a23";
          let size = 72;
          ctx.font = `400 ${size}px Ponnala, sans-serif`;
          while (ctx.measureText(String(name)).width > 1320 && size > 38) {
            size -= 2;
            ctx.font = `400 ${size}px Ponnala, sans-serif`;
          }
          ctx.fillText(String(name), canvas.width / 2, 65);
          doc.addImage(canvas.toDataURL("image/png"), "PNG", x, y, width, height, undefined, "FAST");
        }
        function cardHeight(person) {
          const parents = parentsFor(person).map(labelPerson);
          const spouses = spousesFor(person).map(labelPerson);
          const children = childrenFor(person).map(labelPerson);
          const relationRows = [];
          if (parents.length) relationRows.push(`Parents: ${parents.join(", ")}`);
          if (spouses.length) relationRows.push(`Spouse${spouses.length > 1 ? "s" : ""}: ${spouses.join(", ")}`);
          if (children.length) relationRows.push(`Children: ${children.join(", ")}`);
          const relFont = 9.5;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(relFont);
          const relLines = relationRows.flatMap(row => doc.splitTextToSize(row, cardW - 30));
          doc.setFont("helvetica", "bold");
          doc.setFontSize(16.5);
          const englishLines = doc.splitTextToSize(String(person.fullName || person.id), cardW - 30);
          return { height: 18 + englishLines.length * 19 + (person.teluguName ? 34 : 0) + 6 + Math.max(1, relLines.length) * 12 + 14, englishLines, relationRows, relLines, relFont };
        }
        function drawPersonCard(person, layout) {
          const h = layout.height;
          const type = cardType(person, people);
          const palette = pdfPalette(type);
          doc.setFillColor(...hexRgb(palette.fill));
          doc.setDrawColor(...hexRgb(palette.border));
          doc.setLineWidth(0.9);
          doc.roundedRect(cardX, currentY, cardW, h, 9, 9, "FD");
          doc.setFont("helvetica", "bold");
          doc.setFontSize(16.5);
          doc.setTextColor(31, 42, 35);
          let y = currentY + 23;
          doc.text(layout.englishLines, pageW / 2, y, { align: "center", lineHeightFactor: 1.05 });
          y += layout.englishLines.length * 18 + 1;
          if (person.teluguName) {
            renderTeluguName(person.teluguName, cardX + 14, y, cardW - 28, 31);
            y += 36;
          } else {
            y += 2;
          }
          doc.setDrawColor(226, 228, 218);
          doc.setLineWidth(0.45);
          doc.line(cardX + 14, y, cardX + cardW - 14, y);
          y += 13;
          doc.setFont("helvetica", "normal");
          doc.setFontSize(layout.relFont);
          doc.setTextColor(83, 99, 84);
          if (layout.relLines.length) {
            layout.relLines.forEach(line => {
              doc.text(line, cardX + 15, y);
              y += 12;
            });
          } else {
            doc.text("Parents / spouse / children not recorded", cardX + 15, y);
          }
          doc.setFont("helvetica", "normal");
          doc.setFontSize(7.5);
          doc.setTextColor(130, 130, 117);
          doc.text(person.id, cardX + cardW - 13, currentY + 15, { align: "right" });
          currentY += h + cardGap;
        }

        let first = true;
        for (const generation of [...byGeneration.keys()].sort((a,b) => a-b)) {
          const group = byGeneration.get(generation);
          addDirectoryPage(generation, false);
          first = false;
          for (const { person } of group) {
            const layout = cardHeight(person);
            if (currentY + layout.height > contentBottom) {
              addPageFooter();
              addDirectoryPage(generation, true);
            }
            drawPersonCard(person, layout);
          }
          addPageFooter();
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        doc.save("thoom-family-mobile-directory.pdf");
      } catch (error) {
        console.error("Mobile family directory PDF export failed:", error);
        alert("The mobile directory PDF could not be generated. Please try again. Details: " + (error && error.message ? error.message : String(error)));
      } finally {
        mobileDirectoryButton.textContent = originalLabel;
        mobileDirectoryButton.disabled = false;
        delete mobileDirectoryButton.dataset.busy;
      }
    })();
  }


  if (printButton) printButton.addEventListener("click", exportFullTreePdf);
  if (mobileDirectoryButton) mobileDirectoryButton.addEventListener("click", exportMobileDirectoryPdf);
  populateMainBranches();
  render();
})();
