import type {
	CDPSession,
	CustomQueryHandler,
	ElementHandle,
	Frame,
	JSHandle,
	Page,
	Protocol,
	ProtocolMapping,
} from 'puppeteer';
import {IsTuple, NonEmptyArray} from 'ts-essentials';
import TypedArray = NodeJS.TypedArray;
import {createProducerStream, timeoutSignal} from './utils';

export function isNavigationError(err: unknown): boolean {
	return err instanceof Error
		  && /^Protocol error\b.*\b(?:Session closed|Target closed)|^Execution context was destroyed\b|^Execution context is not available in detached frame\b/i
				.test(err.message);
}

export async function waitForLoad(frame: Frame): Promise<void> {
	return await frame.evaluate(() => new Promise<void>(resolve => {
		function loadHandler() {
			removeEventListener('load', loadHandler);
			resolve();
		}

		addEventListener('load', loadHandler);
		if (document.readyState === 'complete') loadHandler();
	}));
}

/** @return Stack starting with this frame, going up */
export function getFrameStack(frame: Frame): NonEmptyArray<Frame> {
	const frames: NonEmptyArray<Frame> = [frame];
	let curFrame: Frame | null         = frame;
	while ((curFrame = curFrame.parentFrame()))
		frames.push(curFrame);
	return frames;
}

/** Typed version of {@link Page#exposeFunction} */
export async function exposeFunction<Name extends keyof Window & string,
	  Func extends typeof window[Name] & ((this: typeof global, ...args: never) => void)>(
	  page: Page, name: Name, func: Func) {
	await page.exposeFunction(name, func);
}

export const robustPierceQueryHandler: CustomQueryHandler = {
	queryAll(node: Node, selector: string): Node[] {
		// For some Nodes child elements can overwrite properties, so we do this
		// Also, MooTools overwrites Document & Element
		const elementProto = Object.getPrototypeOf(HTMLElement.prototype) as typeof window.Element.prototype;
		/* eslint-disable @typescript-eslint/unbound-method */
		const shadowRoot = Object.getOwnPropertyDescriptor(elementProto, 'shadowRoot')!.get! as (this: Element) => ShadowRoot | null,
		      matches    = Object.getOwnPropertyDescriptor(elementProto, 'matches')!.value as (
			        this: Element, selectors: string) => boolean;
		/* eslint-enable @typescript-eslint/unbound-method */

		function* examineChildren(node: Node): Generator<Element, void, void> {
			if (node instanceof elementProto.constructor) {
				const nodeShadow = shadowRoot.call(node as Element);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}

			// Note: document does not actually matter
			const iter = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
			// First result would be node itself
			while (iter.nextNode()) {
				const child = iter.currentNode as Element;
				if (matches.call(child, selector)) yield child;
				const nodeShadow = shadowRoot.call(child);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}
		}

		return [...examineChildren(node)];
	},
	// Code duplicated from queryAll because these will be injected
	queryOne(node: Node, selector: string): Node | null {
		// For some Nodes child elements can overwrite properties, so we do this
		// Also, MooTools overwrites Document & Element
		const elementProto = Object.getPrototypeOf(HTMLElement.prototype) as typeof window.Element.prototype;
		/* eslint-disable @typescript-eslint/unbound-method */
		const shadowRoot = Object.getOwnPropertyDescriptor(elementProto, 'shadowRoot')!.get! as (this: Element) => ShadowRoot | null,
		      matches    = Object.getOwnPropertyDescriptor(elementProto, 'matches')!.value as (
			        this: Element, selectors: string) => boolean;
		/* eslint-enable @typescript-eslint/unbound-method */

		function* examineChildren(node: Node): Generator<Element, void, void> {
			if (node instanceof elementProto.constructor) {
				const nodeShadow = shadowRoot.call(node as Element);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}

			// Note: document does not actually matter
			const iter = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
			// First result would be node itself
			while (iter.nextNode()) {
				const child = iter.currentNode as Element;
				if (matches.call(child, selector)) yield child;
				const nodeShadow = shadowRoot.call(child);
				if (nodeShadow) yield* examineChildren(nodeShadow);
			}
		}

		const [first] = examineChildren(node);
		return first ?? null;
	},
};

/**
 * Like {@link JSHandle#jsonValue}, but retains some non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandle<T>(handle: JSHandle<T>): Promise<UnwrappedHandle<T>> {
	return await unwrapHandleEx(handle, () => true) as UnwrappedHandle<T>;
}

/**
 * Like {@link JSHandle#jsonValue}, but retains non-serializable objects as {@link JSHandle}s
 */
export async function unwrapHandleEx<T>(
	  handle: JSHandle<T>,
	  shouldUnwrap: (className: string) => boolean = className => ['Object', 'Proxy'].includes(className),
): Promise<UnwrappedHandleEx<T>> {
	const remoteObject = handle.remoteObject();

	// Leave functions & symbols wrapped
	if (['function', 'symbol'].includes(remoteObject.type))
		return handle as UnwrappedHandleEx<T>;

	if (remoteObject.type === 'object') {
		if ([undefined, 'proxy'].includes(remoteObject.subtype)) {
			if (shouldUnwrap(remoteObject.className!))
				return Object.fromEntries(await Promise.all([...await handle.getProperties()]
					  .map(async ([k, v]) => [k, await unwrapHandleEx(v, shouldUnwrap)]))) as UnwrappedHandleEx<T>;
		} else {
			if (remoteObject.subtype === 'null')
				return null as UnwrappedHandleEx<T>;
			if (remoteObject.subtype === 'array')
				return await Promise.all([...await handle.getProperties()]
					  .map(async ([, v]) => await unwrapHandleEx(v, shouldUnwrap))) as UnwrappedHandleEx<T>;
		}
		return handle as UnwrappedHandleEx<T>;

	} else  // Return other types such as numbers, booleans, bigints, etc. unwrapped
		return await handle.jsonValue() as UnwrappedHandleEx<T>;
}

export type UnwrappedHandle<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Node
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandle<T[K]> }
						: UnwrappedHandle<V>[]
				  : T extends RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandle<T[K]> }
							  : unknown;

export type UnwrappedHandleEx<T> = T extends string | boolean | number | null | undefined | bigint
	  ? T
	  : T extends Node
			? ElementHandle<T>
			: T extends (infer V)[]
				  ? T extends IsTuple<T>
						? { [K in keyof T]: UnwrappedHandleEx<T[K]> }
						: UnwrappedHandleEx<V>[]
				  : T extends RegExp | Date | Map<unknown, unknown> | Set<unknown> | WeakMap<object, unknown> | WeakSet<object>
						| Iterator<unknown, never, never> | Error | Promise<unknown> | TypedArray | ArrayBuffer | DataView
						// eslint-disable-next-line @typescript-eslint/ban-types
						| Function | symbol
						? JSHandle<T>
						: T extends object
							  ? { [K in keyof T]: UnwrappedHandleEx<T[K]> } | JSHandle<T>
							  : unknown;

export function attributePairs(attributesResponse: Protocol.DOM.GetAttributesResponse): { name: string, value: string }[] {
	const {attributes} = attributesResponse;
	return Array(attributes.length / 2).fill(undefined)
		  .map((_, i) => ({name: attributes[i * 2]!, value: attributes[i * 2 + 1]!}));
}

export function createCDPReadStream(
	  cdp: CDPSession | TypedCDPSession, handle: Protocol.IO.StreamHandle, timeoutMs?: number) {
	async function* readStream() {
		try {
			let base64Encoded, data, eof;
			do {
				({
					base64Encoded,
					data,
					eof,
				} = await cdp.send('IO.read', {handle}));
				yield {
					chunk: data,
					encoding: base64Encoded === true ? 'base64' as const : undefined,
				};
			} while (!eof);
		} finally {
			await cdp.send('IO.close', {handle});
		}
	}

	return createProducerStream(readStream(), undefined,
		  timeoutMs !== undefined ? timeoutSignal(timeoutMs) : undefined);
}

export type TypedCDPSession = CDPEventEmitter & Omit<CDPSession, keyof CDPEventEmitter>;

interface CDPEventEmitter {
	on<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	off<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	emit(event: keyof ProtocolMapping.Events, eventData?: unknown): boolean;

	once<Event extends keyof ProtocolMapping.Events>(
		  event: Event, handler: (...event: ProtocolMapping.Events[Event]) => void): this;

	listenerCount(event: keyof ProtocolMapping.Events): number;

	removeAllListeners(event?: keyof ProtocolMapping.Events): this;
}

export interface DOMPauseData {
	nodeId: Protocol.DOM.NodeId,
	type: Protocol.DOMDebugger.DOMBreakpointType,
}
