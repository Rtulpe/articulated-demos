import { ClientMutation } from "./client_mutations";

export type ClientMutationMessage = {
  type: "mutation";
  clientId: string;
  mutations: ClientMutation[];
};

export type ClientCursorMessage = {
  type: "cursor";
  clientId: string;
  position: number;
}

export type ClientMessage = ClientMutationMessage | ClientCursorMessage;


