/** A channel the app runs. Keys the persona's hours (`on:`), its contacts' identities, the deny-list and minor flags. Opaque here. */
export type ChannelId = string;

/** Something a DM turn may choose to do besides talking, carried out by the app (`createReplyQueue`'s `act`). */
export interface ChannelAction {
	/** What the model answers in the action field, and what `act` receives. */
	name: string;
	/** Completes `"<name>" …` in the answer format: when to choose it. */
	when: string;
}

/** Where a conversation happens, as the app describes it to the brain. */
export interface Channel {
	id: ChannelId;
	/** Completes "chatting by text in …". */
	where: string;
	/** The longest message sent here; a longer one is cut at a word. */
	maxLength: number;
	/**
	 * The length a group-chat line here should stay under, as the group-chat task asks ("one short line (under N
	 * characters)"); `maxLength` still cuts a longer one. Default: 150, or four fifths of `maxLength` when that is less.
	 */
	targetLength?: number;
	/** Appended word for word to the identity line: what people there see of the persona. */
	identityNote?: string;
	/**
	 * What the model should know about this place in a group-chat or post task here, word for word: a group chat lists
	 * them with its own instructions, a post task after its instruction. A DM turn's lines are `Conversation.extraLines`.
	 */
	notes?: readonly string[];
	/** A DM turn here may answer a pending group-chat invitation (the acceptInvite field). */
	invitations?: boolean;
	/** What a DM turn may do here besides talking and blocking (blocking is always offered). */
	actions?: readonly ChannelAction[];
	/**
	 * The conversation here is 18+: turns on soulframe's one built-in safeguard, avoiding minors (the code's under-18
	 * check on incoming messages, with its goodbye and deny-list; the Decisions age check and its caution; the "adults
	 * only" rule line). Off by default: none of it runs or appears in a prompt.
	 */
	adult?: boolean;
}
