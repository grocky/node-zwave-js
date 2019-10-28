import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import log from "../log";
import { getEnumMemberName, validatePayload } from "../util/misc";
import { Duration } from "../values/Duration";
import { ValueMetadata } from "../values/Metadata";
import { Maybe, parseMaybeNumber, parseNumber } from "../values/Primitive";
import {
	CCAPI,
	SetValueImplementation,
	SET_VALUE,
	throwUnsupportedProperty,
	throwWrongValueType,
} from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	ccValue,
	ccValueMetadata,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

export enum MultilevelSwitchCommand {
	Set = 0x01,
	Get = 0x02,
	Report = 0x03,
	StartLevelChange = 0x04,
	StopLevelChange = 0x05,
	SupportedGet = 0x06,
	SupportedReport = 0x07,
}

export enum LevelChangeDirection {
	"up" = 0b0,
	"down" = 0b1,
	"none" = 0b11,
}

export enum SwitchType {
	"not supported" = 0x00,
	"Off/On" = 0x01,
	"Down/Up" = 0x02,
	"Close/Open" = 0x03,
	"CCW/CW" = 0x04,
	"Left/Right" = 0x05,
	"Reverse/Forward" = 0x06,
	"Pull/Push" = 0x07,
}

@API(CommandClasses["Multilevel Switch"])
export class MultilevelSwitchCCAPI extends CCAPI {
	public supportsCommand(cmd: MultilevelSwitchCommand): Maybe<boolean> {
		switch (cmd) {
			case MultilevelSwitchCommand.Get:
			case MultilevelSwitchCommand.Set:
			case MultilevelSwitchCommand.StartLevelChange:
			case MultilevelSwitchCommand.StopLevelChange:
				return true; // This is mandatory
			case MultilevelSwitchCommand.SupportedGet:
				return this.version >= 3;
		}
		return super.supportsCommand(cmd);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	public async get() {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.Get,
		);

		const cc = new MultilevelSwitchCCGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			MultilevelSwitchCCReport
		>(cc))!;
		return {
			currentValue: response.currentValue,
			targetValue: response.targetValue,
			duration: response.duration,
		};
	}

	/**
	 * Sets the switch to a new value
	 * @param targetValue The new target value for the switch
	 * @param duration The optional duration to reach the target value. Available in V2+
	 */
	// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
	public async set(targetValue: number, duration?: Duration) {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.Set,
		);

		const cc = new MultilevelSwitchCCSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			targetValue,
			duration,
		});
		await this.driver.sendCommand(cc);

		// Refresh the current value
		await this.get();
	}

	public async startLevelChange(
		options: Omit<
			MultilevelSwitchCCStartLevelChangeOptions,
			keyof CCCommandOptions
		>,
	): Promise<void> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.StartLevelChange,
		);

		const cc = new MultilevelSwitchCCStartLevelChange(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			...options,
		});
		await this.driver.sendCommand(cc);
	}

	public async stopLevelChange(): Promise<void> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.StopLevelChange,
		);

		const cc = new MultilevelSwitchCCStopLevelChange(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		await this.driver.sendCommand(cc);
	}

	public async getSupported(): Promise<SwitchType> {
		this.assertSupportsCommand(
			MultilevelSwitchCommand,
			MultilevelSwitchCommand.SupportedGet,
		);

		const cc = new MultilevelSwitchCCSupportedGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			MultilevelSwitchCCSupportedReport
		>(cc))!;
		return response.primarySwitchType;
	}

	protected [SET_VALUE]: SetValueImplementation = async (
		{ propertyName },
		value,
	): Promise<void> => {
		if (propertyName !== "targetValue") {
			throwUnsupportedProperty(this.ccId, propertyName);
		}
		if (typeof value !== "number") {
			throwWrongValueType(
				this.ccId,
				propertyName,
				"number",
				typeof value,
			);
		}
		await this.set(value);
	};
}

export interface MultilevelSwitchCC {
	ccCommand: MultilevelSwitchCommand;
}

@commandClass(CommandClasses["Multilevel Switch"])
@implementedVersion(4)
export class MultilevelSwitchCC extends CommandClass {
	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const api = this.getEndpoint()!.commandClasses["Multilevel Switch"];

		log.controller.logNode(node.id, {
			message: `${this.constructor.name}: doing a ${
				complete ? "complete" : "partial"
			} interview...`,
			direction: "none",
		});

		if (complete && this.version >= 3) {
			// Find out which kind of switch this is
			log.controller.logNode(node.id, {
				message: "requesting primary switch type...",
				direction: "outbound",
			});
			const switchType = await api.getSupported();
			log.controller.logNode(node.id, {
				message: `has switch type ${getEnumMemberName(
					SwitchType,
					switchType,
				)}`,
				direction: "inbound",
			});
		}

		log.controller.logNode(node.id, {
			message: "requesting current switch state...",
			direction: "outbound",
		});
		await api.get();

		// Remember that the interview is complete
		this.interviewComplete = true;
	}
}

interface MultilevelSwitchCCSetOptions extends CCCommandOptions {
	targetValue: number;
	// Version >= 2:
	duration?: Duration;
}

@CCCommand(MultilevelSwitchCommand.Set)
export class MultilevelSwitchCCSet extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options:
			| CommandClassDeserializationOptions
			| MultilevelSwitchCCSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.targetValue = options.targetValue;
			this.duration = options.duration;
		}
	}

	public targetValue: number;
	public duration: Duration | undefined;

	public serialize(): Buffer {
		const payload = [this.targetValue];
		if (this.version >= 2 && this.duration) {
			payload.push(this.duration.serializeSet());
		}
		this.payload = Buffer.from(payload);
		return super.serialize();
	}
}

@CCCommand(MultilevelSwitchCommand.Report)
export class MultilevelSwitchCCReport extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		validatePayload(this.payload.length >= 1);
		// if the payload contains a reserved value, return the actual value
		// instead of undefined
		this._currentValue =
			parseMaybeNumber(this.payload[0]) || this.payload[0];
		if (this.version >= 4 && this.payload.length >= 3) {
			this._targetValue = parseNumber(this.payload[1]);
			this._duration = Duration.parseReport(this.payload[2]);
		}
		this.persistValues();
	}

	private _targetValue: number | undefined;
	@ccValue()
	@ccValueMetadata({
		...ValueMetadata.Level,
		label: "Target value",
	})
	public get targetValue(): number | undefined {
		return this._targetValue;
	}

	private _duration: Duration | undefined;
	@ccValue()
	@ccValueMetadata({
		...ValueMetadata.ReadOnly,
		label: "Remaining duration until target value",
	})
	public get duration(): Duration | undefined {
		return this._duration;
	}

	private _currentValue: Maybe<number>;
	@ccValue()
	@ccValueMetadata({
		...ValueMetadata.ReadOnlyLevel,
		label: "Current value",
	})
	public get currentValue(): Maybe<number> {
		return this._currentValue;
	}
}

@CCCommand(MultilevelSwitchCommand.Get)
@expectedCCResponse(MultilevelSwitchCCReport)
export class MultilevelSwitchCCGet extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

interface MultilevelSwitchCCStartLevelChangeOptions extends CCCommandOptions {
	primarySwitchDirection: keyof typeof LevelChangeDirection;
	ignoreStartLevel: boolean;
	primarySwitchStartLevel: number;
	// Version >= 2:
	duration?: Duration;
	// This does not include the Version 3+ secondary switch type
	// According to SDS13781, it has been DEPRECATED
}

@CCCommand(MultilevelSwitchCommand.StartLevelChange)
export class MultilevelSwitchCCStartLevelChange extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options:
			| CommandClassDeserializationOptions
			| MultilevelSwitchCCStartLevelChangeOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.duration = options.duration;
			this.primarySwitchStartLevel = options.primarySwitchStartLevel;
			this.ignoreStartLevel = options.ignoreStartLevel;
			this.primarySwitchDirection = options.primarySwitchDirection;
		}
	}

	public duration: Duration | undefined;
	public primarySwitchStartLevel: number;
	public ignoreStartLevel: boolean;
	public primarySwitchDirection: keyof typeof LevelChangeDirection;

	public serialize(): Buffer {
		const controlByte =
			(LevelChangeDirection[this.primarySwitchDirection] << 6) |
			(this.ignoreStartLevel ? 0b0010_0000 : 0);
		const payload = [controlByte, this.primarySwitchStartLevel];
		if (this.version >= 2 && this.duration) {
			payload.push(this.duration.serializeSet());
		}
		this.payload = Buffer.from(payload);
		return super.serialize();
	}
}

@CCCommand(MultilevelSwitchCommand.StopLevelChange)
export class MultilevelSwitchCCStopLevelChange extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

@CCCommand(MultilevelSwitchCommand.SupportedReport)
export class MultilevelSwitchCCSupportedReport extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		validatePayload(this.payload.length >= 2);
		this._primarySwitchType = this.payload[0] & 0b11111;
		this.persistValues();
	}

	// TODO: Use these to create the correct values/buttons

	private _primarySwitchType: SwitchType;
	@ccValue({ internal: true })
	public get primarySwitchType(): SwitchType {
		return this._primarySwitchType;
	}
}

@CCCommand(MultilevelSwitchCommand.SupportedGet)
@expectedCCResponse(MultilevelSwitchCCSupportedReport)
export class MultilevelSwitchCCSupportedGet extends MultilevelSwitchCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}
