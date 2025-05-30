import { ElementId, IdList } from "articulated";
import "prosemirror-menu/style/menu.css";
import { Node } from "prosemirror-model";
import {
  AllSelection,
  EditorState,
  Selection,
  TextSelection,
  Transaction,
} from "prosemirror-state";
import { ReplaceStep, Step } from "prosemirror-transform";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { Plugin, PluginKey, EditorState as PMEditorState } from "prosemirror-state";
import "prosemirror-view/style/prosemirror.css";
import {
  allHandlers,
  ClientMutation,
  ClientMutationHandler,
  DeleteHandler,
  InsertHandler,
} from "../common/client_mutations";
import { schema } from "../common/prosemirror";
import {
  ServerHelloMessage,
  ServerMutationMessage,
} from "../common/server_messages";
import { TrackedIdList } from "../common/tracked_id_list";
import type { ClientCursorMessage } from "../common/client_messages";

const DEBUG = false;
const META_KEY = "ProsemirrorWrapper";

export class ProseMirrorWrapper {
  readonly view: EditorView;

  private nextClientCounter = 1;

  private nextBunchIdCounter = 0;

  /**
   * The last state received from the server.
   */
  private serverState: EditorState;
  private serverIdList: IdList;

  /**
   * Our pending local mutations, which have not yet been confirmed by the server.
   */
  private pendingMutations: ClientMutation[] = [];
  /**
   * Our current IdList with the pending mutations applied. It matches this.view.state.doc.
   */
  private trackedIds: TrackedIdList;

  private _remoteCursorOverlays: Map<string, HTMLElement> = new Map();
  private _remoteCursorPositions: Map<string, number> = new Map();

  constructor(
    readonly clientId: string,
    readonly onLocalMutation: (mutation: ClientMutation) => void,
    readonly onCursorChange: (sel: IdSelection, pos: number) => void,
    helloMessage: ServerHelloMessage
  ) {
    this.serverState = EditorState.create({
      schema,
      doc: Node.fromJSON(schema, helloMessage.docJson),
    });
    this.serverIdList = IdList.load(helloMessage.idListJson);

    this.view = new EditorView(document.querySelector("#editor"), {
      state: this.serverState,
      dispatchTransaction: (tr) => this.dispatchTransaction(tr),
    });
    this.trackedIds = new TrackedIdList(this.serverIdList, false);
    this._remoteCursorOverlays = new Map();
    window.addEventListener("scroll", () => this.updateAllRemoteCursorOverlays(), true);
    window.addEventListener("resize", () => this.updateAllRemoteCursorOverlays());
  }

  private updateAllRemoteCursorOverlays() {
    for (const [clientId, overlay] of this._remoteCursorOverlays.entries()) {
      // Find the position for this client (parse from overlay id)
      // We need to store the last known position for each client
      // Store it in a new map: _remoteCursorPositions
      if (!this._remoteCursorPositions) continue;
      const pos = this._remoteCursorPositions.get(clientId);
      if (typeof pos === "number") {
        const coords = this.view.coordsAtPos(pos);
        overlay.style.left = coords.left + "px";
        overlay.style.top = coords.top + "px";
        overlay.style.height = (coords.bottom - coords.top) + "px";
      }
    }
  }

  private dispatchTransaction(tr: Transaction): void {
    // Detect selection-only changes
    if (tr.getMeta(META_KEY) !== undefined || tr.steps.length === 0) {
      const prevSel = this.view.state.selection;
      const nextState = this.view.state.apply(tr);
      const nextSel = nextState.selection;
      this.view.updateState(nextState);
      // Only fire if selection actually changed
      if (
        (prevSel.from !== nextSel.from || prevSel.to !== nextSel.to) &&
        this.onCursorChange
      ) {
        const idSel = selectionToIds(nextState, this.trackedIds.idList);
        this.onCursorChange(idSel, nextSel.from);
      }
      return;
    }

    // The tr has steps but was not issued by us. It's a user input that we need
    // to reverse engineer and convert to a mutation.
    for (let i = 0; i < tr.steps.length; i++) {
      const step = tr.steps[i];
      if (step instanceof ReplaceStep) {
        // Delete part
        if (step.from < step.to) {
          const startId = this.trackedIds.idList.at(step.from);
          if (step.to === step.from + 1) {
            this.mutate(DeleteHandler, { startId });
          } else {
            this.mutate(DeleteHandler, {
              startId,
              endId: this.trackedIds.idList.at(step.to - 1),
              contentLength: step.to - step.from + 1,
            });
          }
        }
        // Insert part
        if (step.slice.size > 0) {
          if (
            !(
              step.slice.content.childCount === 1 &&
              step.slice.content.firstChild!.isText
            )
          ) {
            console.error("Unsupported insert slice:", step.slice);
            // Skip future steps because their positions may be messed up.
            break;
          }

          const content = step.slice.content.firstChild!.text!;

          // Set isInWord if the first inserted char and the preceding char are both letters.
          let isInWord = false;
          if (/[a-zA-z]/.test(content[0]) && step.from > 0) {
            const beforeChar = tr.docs[i].textBetween(step.from - 1, step.from);
            if (beforeChar.length > 0 && /[a-zA-z]/.test(beforeChar[0])) {
              isInWord = true;
            }
          }

          const before =
            step.from === 0 ? null : this.trackedIds.idList.at(step.from - 1);
          const newId = this.newId(before, this.trackedIds.idList);
          this.mutate(InsertHandler, {
            before,
            id: newId,
            content,
            isInWord,
          });
        }
      } else {
        console.error("Unsupported step:", step);
        // Skip future steps because their positions may be messed up.
        break;
      }
    }
  }

  private newId(before: ElementId | null, idList: IdList): ElementId {
    if (before !== null && before.bunchId.startsWith(this.clientId)) {
      if (idList.maxCounter(before.bunchId) === before.counter) {
        return { bunchId: before.bunchId, counter: before.counter + 1 };
      }
    }

    const bunchId = `${this.clientId}_${this.nextBunchIdCounter++}`;
    return { bunchId, counter: 0 };
  }

  /**
   * Performs a local mutation. This is what you should call in response to user
   * input, instead of updating the Prosemirror state directly.
   */
  mutate<T>(handler: ClientMutationHandler<T>, args: T): void {
    const clientCounter = this.nextClientCounter;
    const mutation: ClientMutation = {
      name: handler.name,
      args,
      clientCounter,
    };

    // Perform locally.
    const tr = this.view.state.tr;
    handler.apply(tr, this.trackedIds, args);
    tr.setMeta(META_KEY, true);
    this.view.updateState(this.view.state.apply(tr));

    // Store and send to server.
    this.nextClientCounter++;
    this.pendingMutations.push(mutation);
    this.onLocalMutation(mutation);
  }

  // TODO: Batching - only need to do this once every 100ms or so (less if it's taking too long).
  receive(mutation: ServerMutationMessage): void {
    // Store the user's selection in terms of ElementIds.
    const idSel = selectionToIds(this.view.state, this.trackedIds.idList);

    // Apply the mutation to our copy of the server's state.
    const serverTr = this.serverState.tr;
    serverTr.setMeta(META_KEY, true);
    for (const stepJson of mutation.stepsJson) {
      serverTr.step(Step.fromJSON(schema, stepJson));
    }
    this.serverState = this.serverState.apply(serverTr);

    const serverTrackedIds = new TrackedIdList(this.serverIdList, false);
    for (const update of mutation.idListUpdates) {
      serverTrackedIds.apply(update);
    }
    this.serverIdList = serverTrackedIds.idList;

    // Remove confirmed local mutations.
    if (mutation.senderId === this.clientId) {
      const lastConfirmedIndex = this.pendingMutations.findIndex(
        (pending) => pending.clientCounter === mutation.senderCounter
      );
      if (lastConfirmedIndex !== -1) {
        this.pendingMutations = this.pendingMutations.slice(
          lastConfirmedIndex + 1
        );
      }
    }

    // Re-apply pending local mutations to the new server state.
    const tr = this.serverState.tr;
    this.trackedIds = new TrackedIdList(this.serverIdList, false);
    for (const pending of this.pendingMutations) {
      const handler = allHandlers.find(
        (handler) => handler.name === pending.name
      )!;
      handler.apply(tr, this.trackedIds, pending.args);
    }

    // Restore selection.
    tr.setSelection(selectionFromIds(idSel, tr.doc, this.trackedIds.idList));

    tr.setMeta(META_KEY, true);
    tr.setMeta("addToHistory", false);
    this.view.updateState(this.serverState.apply(tr));
  }

  // Cursor tracking of other users.
  receiveCursor(cursorMsg: ClientCursorMessage): void {
    if (cursorMsg.clientId === this.clientId) return;
    const doc = this.view.state.doc;
    const { cursor } = cursorMsg;
    let pos: number;
    if (typeof cursor.position === "number") {
      pos = Math.max(0, Math.min(doc.content.size, cursor.position));
    } else {
      pos = this.serverIdList.indexOf(cursor.position, "right");
      if (pos < 0) pos = 0;
    }
    this.renderRemoteCursorOverlay(cursorMsg.clientId, pos);
  }

  private renderRemoteCursorOverlay(clientId: string, pos: number) {
    // Remove any existing overlay for this client
    let existing = this._remoteCursorOverlays.get(clientId);
    if (existing) existing.remove();
    // Get coordinates for the position
    const coords = this.view.coordsAtPos(pos);
    // Create overlay
    const overlay = document.createElement("div");
    overlay.id = `remote-cursor-overlay-${clientId}`;
    overlay.className = "remote-cursor-overlay";
    overlay.style.position = "absolute";
    overlay.style.left = coords.left + "px";
    overlay.style.top = coords.top + "px";
    overlay.style.height = (coords.bottom - coords.top) + "px";
    overlay.style.width = "2px";
    overlay.style.background = this.colorForClient(clientId);
    overlay.style.zIndex = "1000";
    overlay.style.pointerEvents = "none";
    // Optional: add label
    const label = document.createElement("div");
    label.textContent = clientId;
    label.style.position = "absolute";
    label.style.top = "-1.2em";
    label.style.left = "-10px";
    label.style.background = this.colorForClient(clientId);
    label.style.color = "#fff";
    label.style.fontSize = "10px";
    label.style.padding = "0 4px";
    label.style.borderRadius = "3px";
    label.style.whiteSpace = "nowrap";
    overlay.appendChild(label);
    // Append to editor's offsetParent (usually the editor container)
    const container = this.view.dom.offsetParent || document.body;
    container.appendChild(overlay);
    // Store for later cleanup if needed
    this._remoteCursorOverlays.set(clientId, overlay);
    // Store the position for later updates
    if (!this._remoteCursorPositions) this._remoteCursorPositions = new Map();
    this._remoteCursorPositions.set(clientId, pos);
  }

  // Remove all remote cursor overlays (e.g., on destroy or re-render)
  private removeAllRemoteCursorOverlays() {
    for (const overlay of this._remoteCursorOverlays.values()) {
      overlay.remove();
    }
    this._remoteCursorOverlays.clear();
  }

  private colorForClient(clientId: string): string {
    const colors = [
      "#e57373",
      "#64b5f6",
      "#81c784",
      "#ffd54f",
      "#ba68c8",
      "#4dd0e1",
      "#ffb74d",
      "#a1887f",
    ];
    let hash = 0;
    for (let i = 0; i < clientId.length; i++)
      hash = (hash * 31 + clientId.charCodeAt(i)) % colors.length;
    return colors[Math.abs(hash) % colors.length];
  }
}

// Remove the cursorWidget method and .remote-cursor CSS, as overlays are now used

type IdSelection =
  | {
      type: "all";
    }
  | { type: "cursor"; id: ElementId }
  | { type: "textRange"; start: ElementId; end: ElementId; forwards: boolean }
  | { type: "unsupported" };

function selectionToIds(state: EditorState, idList: IdList): IdSelection {
  if (state.selection instanceof AllSelection) {
    return { type: "all" };
  } else if (state.selection.to === state.selection.from) {
    return { type: "cursor", id: idList.at(state.selection.from) };
  } else if (state.selection instanceof TextSelection) {
    const { from, to, anchor, head } = state.selection;
    return {
      type: "textRange",
      start: idList.at(from),
      end: idList.at(to - 1),
      forwards: head > anchor,
    };
  } else {
    console.error("Unsupported selection:", state.selection);
    return { type: "unsupported" };
  }
}

function selectionFromIds(
  idSel: IdSelection,
  doc: Node,
  idList: IdList
): Selection {
  switch (idSel.type) {
    case "all":
      return new AllSelection(doc);
    case "cursor":
      let pos = idList.indexOf(idSel.id, "left");
      if (pos < 0) pos = 0;
      return Selection.near(doc.resolve(pos));
    case "textRange":
      const from = idList.indexOf(idSel.start, "right");
      const to = idList.indexOf(idSel.end, "left");
      if (to < from) return Selection.near(doc.resolve(from));
      const [anchor, head] = idSel.forwards ? [from, to] : [to, from];
      return TextSelection.between(doc.resolve(anchor), doc.resolve(head));
    case "unsupported":
      // Set cursor to the first char.
      return Selection.atStart(doc);
  }
}
