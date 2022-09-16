import {filter, groupBy, map, pipe, reverse, zip} from 'rambda';
import {RequestCollector} from 'tracker-radar-collector';
import ValueSearcher from 'value-searcher';

import {formatDuration, nonEmpty, notFalsy} from './utils';
import {OutputFile, SavedCallEx, ThirdPartyInfo} from './main';
import {selectorStr, stackFrameFileRegex} from './pageUtils';
import {ClickLinkEvent, FillEvent, FullFieldsCollectorOptions, SubmitEvent} from './FieldsCollector';

export function getSummary(output: OutputFile, fieldsCollectorOptions: FullFieldsCollectorOptions): string {
	const result = output.crawlResult;
	const time   = (timestamp: number) =>
		  `⌚️${((timestamp - result.testStarted) / 1e3).toFixed(1)}s`;

	const strings: string[] = [];
	const write             = (str: string) => strings.push(str);
	const writeln           = (str = '') => {
		if (str) strings.push(str);
		strings.push('\n');
	};

	writeln(`Crawl of ${result.initialUrl}`);
	if (result.finalUrl !== result.initialUrl)
		writeln(`URL after redirects: ${result.finalUrl}`);
	writeln(`Took ${formatDuration(result.testFinished - result.testStarted)}`);
	writeln();

	const thirdPartyInfoStr = ({thirdParty, tracker}: Partial<ThirdPartyInfo>): string =>
		  `${thirdParty === true ? 'third party ' : ''
		  }${tracker === true ? '🕵 tracker ' : ''}`;

	const collectorData = result.data;
	const fieldsData    = collectorData.fields;
	if (fieldsData) {
		if (fieldsData.passwordLeaks.length) {
			writeln('⚠️ 🔑 Password was written to the DOM:');
			for (const leak of fieldsData.passwordLeaks) {
				writeln(`${time(leak.time)} to attribute "${leak.attribute}" on element "${selectorStr(leak.selector)}"; frame stack (bottom→top):`);
				for (const frame of leak.attrs?.frameStack ?? leak.frameStack!)
					writeln(`\t${frame}`);
			}
			writeln('If a script then extracts the DOM it might leak the password\n');
		}
	} else writeln('❌️ No fields collector data, it probably crashed\n');

	if (!collectorData.requests) writeln('⚠️ No request collector data found');
	if (output.leakedValues) {
		const annotatedLeaks = output.leakedValues
			  .map(leak => {
				  const request       = leak.requestIndex !== undefined ? collectorData.requests![leak.requestIndex]! : undefined,
				        visitedTarget = leak.visitedTargetIndex !== undefined ? collectorData.fields!.visitedTargets[leak.visitedTargetIndex]! : undefined;
				  return {
					  ...leak,
					  request,
					  visitedTarget,
				  };
			  });
		const hasDomainInfo  = !!annotatedLeaks[0] && (annotatedLeaks[0].request ?? annotatedLeaks[0].visitedTarget!).thirdParty !== undefined;
		const importantLeaks = hasDomainInfo ? annotatedLeaks.filter(({request, visitedTarget}) => {
			const {thirdParty, tracker} = request ?? visitedTarget!;
			return thirdParty! || tracker!;
		}) : annotatedLeaks;
		if (importantLeaks.length) {
			writeln(`ℹ️ 🖅 Values were sent in web requests${hasDomainInfo ? ' to third parties' : ''}:`);
			for (const leak of importantLeaks) {
				const reqTime = leak.visitedTarget?.time ?? leak.request!.wallTime;
				write(`${reqTime !== undefined ? `${time(reqTime)} ` : ''}${leak.type} sent in ${leak.part}`);
				const thirdPartyInfo = leak.request ?? leak.visitedTarget!;
				if (leak.request) {
					write(` of request to ${thirdPartyInfoStr(thirdPartyInfo)}"${leak.request.url}"`);
					if (nonEmpty(leak.request.stack)) {
						writeln(' by:');
						for (const frame of leak.request.stack)
							writeln(`\t${frame}`);
					}
					writeln();
				} else {
					writeln(` for navigation to ${thirdPartyInfoStr(thirdPartyInfo)}${leak.visitedTarget!.url}`);
				}
			}
			writeln();
		} else writeln(`✔️ No leaks ${output.leakedValues.length ? 'to third parties ' : ''}detected\n`);
	} else writeln('⚠️ No leaked value data found\n');

	if (collectorData.apis) {
		const searchValues    = [
			fieldsCollectorOptions.fill.email,
			fieldsCollectorOptions.fill.password,
		];
		const fieldValueCalls = pipe(
			  filter(({description}: SavedCallEx) => description === 'HTMLInputElement.prototype.value'),
			  filter(({custom: {value}}) => searchValues.includes(value)),
			  groupBy(({custom: {selectorChain, type, value}, stack}) =>
					`${selectorChain ? selectorStr(selectorChain) : ''}\0${type}\0${value}\0${stack!.join('\n')}`),
			  (Object.entries<SavedCallEx[]>),
			  map(([, calls]) => {
				  const {custom: {selectorChain, type, value}, stack, stackInfo} = calls[0]!;
				  return [
					  {selectorChain, type, value, stack: stack!, stackInfo: stackInfo!},
					  calls.map(({custom: {time}}) => time),
				  ] as const;
			  }),
		)(collectorData.apis.savedCalls);

		if (fieldValueCalls.length) {
			writeln('ℹ️ 🔍 Field value reads:');
			for (const [call, times] of fieldValueCalls) {
				write(`${times.map(time).join(' ')} access to ${
					  call.value === fieldsCollectorOptions.fill.password ? '🔑 ' : '📧 '
				}value of ${call.type} field`);
				if (call.selectorChain) write(` "${selectorStr(call.selectorChain)}"`);
				writeln(' by:');

				const displayFrames = [];
				let prevFile: string | undefined;
				for (const [frame, frameInfo] of reverse(zip(call.stack, call.stackInfo)))
					displayFrames.push(
						  frame.replace(stackFrameFileRegex,
								file => {
									const ret = prevFile === file
										  ? '↓'
										  : `${thirdPartyInfoStr(frameInfo ?? {})}${file}`;
									prevFile  = file;
									return ret;
								}));
				displayFrames.reverse();
				for (const frame of displayFrames)
					writeln(`\t${frame}`);
				writeln();
			}
			writeln();
		}
	} else writeln('⚠️ No API call data found\n');

	if (fieldsData) {
		writeln('📊 Automated crawl statistics:\n');
		writeln(`📑 ${fieldsData.fields.length} fields found`);
		writeln(`✒️ ${fieldsData.events.filter(ev => ev instanceof FillEvent).length} fields filled`);
		writeln(`⏎ ${fieldsData.events.filter(ev => ev instanceof SubmitEvent).length} fields submitted`);
		writeln(`🔗 ${fieldsData.links?.length ?? 0} links found`);
		writeln(`🖱 ${fieldsData.events.filter(ev => ev instanceof ClickLinkEvent).length} links clicked`);

		if (fieldsData.errors.length) {
			writeln('\nFields collector errors:');
			for (const error of fieldsData.errors)
				writeln(`\t${error.level === 'error' ? '❌️' : '⚠️'} ${
					  typeof error.context[0] === 'string' ? `${error.context[0]} ` : ''
				}${String(error.error)}`);
			writeln();
		}
	}

	return strings.join('');
}

export async function findValue(
	  searcher: ValueSearcher,
	  requests: readonly RequestCollector.RequestData[],
	  visitedTargets: readonly string[] = [],
): Promise<FindEntry[]> {
	const requestUrls = new Set(requests.map(({url}) => url));
	return (await Promise.all([
		...requests.flatMap((request, requestIndex) => [
			searcher.findValueIn(Buffer.from(request.url))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'url',
					  encodings: encoders.map(String),
				  } as const),
			...Object.entries(request.requestHeaders ?? {})
				  .map(([name, value]) =>
						searcher.findValueIn(Buffer.from(value))
							  .then(encoders => encoders && {
								  requestIndex,
								  part: 'header',
								  header: name,
								  encodings: encoders.map(String),
							  } as const)),
			request.postData && searcher.findValueIn(Buffer.from(request.postData))
				  .then(encoders => encoders && {
					  requestIndex,
					  part: 'body',
					  encodings: encoders.map(String),
				  } as const),
		]),
		...visitedTargets
			  .map((url, visitedTargetIndex) => ({url, visitedTargetIndex}))
			  .filter(({url}) => !requestUrls.has(url))
			  .map(({url, visitedTargetIndex}) => searcher.findValueIn(Buffer.from(url))
					.then(encoders => encoders && {
						visitedTargetIndex,
						part: 'url',
						encodings: encoders.map(String),
					} as const)),
	])).filter(notFalsy);
}

export interface FindEntry {
	/** Index in requests */
	requestIndex?: number;
	/** Index in visitedTargets, mutually exclusive with {@link requestIndex} */
	visitedTargetIndex?: number;
	part: 'url' | 'header' | 'body';
	header?: string;
	/** Encodings (e.g. `uri`) that were used to encode value, outside-in */
	encodings: string[];
}
