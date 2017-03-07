import _ from 'lodash';
import SerialPort from 'serialport';
import log from '../../lib/log';
import EventTrigger from '../../lib/event-trigger';
import Feeder from '../../lib/feeder';
import Sender, { SP_TYPE_CHAR_COUNTING } from '../../lib/sender';
import Workflow, {
    WORKFLOW_STATE_IDLE,
    WORKFLOW_STATE_RUNNING
} from '../../lib/workflow';
import config from '../../services/configstore';
import monitor from '../../services/monitor';
import taskRunner from '../../services/taskrunner';
import store from '../../store';
import Smoothie from './Smoothie';
import {
    SMOOTHIE,
    SMOOTHIE_ACTIVE_STATE_HOLD,
    SMOOTHIE_REALTIME_COMMANDS
} from './constants';
const WebSocket = require('ws');
const EventEmitter = require('events');

const noop = _.noop;

const dbg = (...args) => {
    log.raw.apply(log, ['silly'].concat(args));
};

class SerialPortWS extends EventEmitter
{
	constructor(port, options)
	{
		super();
		
		this.port = port;
		this.options = options;
		
		this.parser = options.parser;
		
		this.socket = null;
	}
	
	open(cb) {
		this.socket = new WebSocket('ws://' + this.port);
	
		this.socket.on('open', () => {
			cb(null);
		});
	
		this.socket.on('close', () => {
		
		});
	
		this.socket.on('message', (data, flags) => {
			this.parser(this, data);
		});
	}
	
	write(data) {
		this.socket.send(data);
	}
	
	isOpen() {
		return this.socket != null;
	}
}

class Connection {
    socket = null;
    sentCommand = '';

    constructor(socket) {
        this.socket = socket;
    }
}

class SmoothieController {
    type = SMOOTHIE;

    // Connections
    connections = {};

    // SerialPort
    options = {
        port: '',
        baudrate: 115200
    };
    serialport = null;

    // Smoothie
    smoothie = null;
    ready = false;
    state = {};
    queryTimer = null;
    actionMask = {
        queryParserState: {
            state: false, // wait for a message containing the current G-code parser modal state
            reply: false // wait for an `ok` or `error` response
        },
        queryStatusReport: false,

        // Respond to user input
        replyParserState: false, // $G
        replyStatusReport: false // ?
    };
    feedOverride = 100;
    spindleOverride = 100;

    // Event Trigger
    event = null;

    // Feeder
    feeder = null;

    // Sender
    sender = null;

    // Workflow
    workflow = null;

    constructor(port, options) {
        const { baudrate } = { ...options };

        this.options = {
            ...this.options,
            port: port,
            baudrate: baudrate
        };

        // Event Trigger
        this.event = new EventTrigger((event, trigger, command) => {
            log.debug(`[Smoothie] EventTrigger: event="${event}", trigger="${trigger}", command="${command}"`);
            if (trigger === 'system') {
                taskRunner.run(command);
            } else {
                this.command(null, 'gcode', command);
            }
        });

        // Feeder
        this.feeder = new Feeder();
        this.feeder.on('data', (command = '') => {
            if (this.isClose()) {
                log.error(`[Smoothie] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            const line = String(command).trim();
            if (line.length === 0) {
                return;
            }

            this.emitAll('serialport:write', line);

            this.serialport.write(line + '\n');
            dbg(`[Smoothie] > ${line}`);
        });

        // Sender
        this.sender = new Sender(SP_TYPE_CHAR_COUNTING, {
            // Deduct the length of periodic commands ('$G\n', '?') to prevent from buffer overrun
            bufferSize: (128 - 8) // The default buffer size is 128 bytes
        });
        this.sender.on('data', (gcode = '') => {
            if (this.isClose()) {
                log.error(`[Smoothie] Serial port "${this.options.port}" is not accessible`);
                return;
            }

            if (this.workflow.state !== WORKFLOW_STATE_RUNNING) {
                log.error(`[Smoothie] Unexpected workflow state: ${this.workflow.state}`);
                return;
            }

            gcode = ('' + gcode).trim();
            if (gcode.length > 0) {
                this.serialport.write(gcode + '\n');
                dbg(`[Smoothie] > ${gcode}`);
            }
        });

        // Workflow
        this.workflow = new Workflow();
        this.workflow.on('start', () => {
            this.sender.rewind();
        });
        this.workflow.on('stop', () => {
            this.sender.rewind();
        });
        this.workflow.on('resume', () => {
            this.sender.next();
        });

        // Smoothie
        this.smoothie = new Smoothie();

        this.smoothie.on('raw', noop);

        this.smoothie.on('status', (res) => {
            this.actionMask.queryStatusReport = false;

            // Do not change buffer size during gcode sending (#133)
            if (this.workflow.state === WORKFLOW_STATE_IDLE && this.sender.sp.dataLength === 0) {
                // Check if Smoothie reported the rx buffer (#115)
                if (res && res.buf && res.buf.rx) {
                    const rx = Number(res.buf.rx) || 0;
                    // Deduct the length of periodic commands ('$G\n', '?') to prevent from buffer overrun
                    const bufferSize = (rx - 8);
                    if (bufferSize > this.sender.sp.bufferSize) {
                        this.sender.sp.bufferSize = bufferSize;
                    }
                }
            }

            if (this.actionMask.replyStatusReport) {
                this.actionMask.replyStatusReport = false;
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.smoothie.on('ok', (res) => {
            if (this.actionMask.queryParserState.reply) {
                if (this.actionMask.replyParserState) {
                    this.actionMask.replyParserState = false;
                    this.emitAll('serialport:read', res.raw);
                }
                this.actionMask.queryParserState.reply = false;

                return;
            }

            // Sender
            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emitAll('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.smoothie.on('error', (res) => {
            // Sender
            if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
                const { lines, received } = this.sender.state;
                const line = lines[received] || '';

                this.emitAll('serialport:read', `> ${line.trim()} (line=${received + 1})`);
                this.emitAll('serialport:read', res.raw);

                this.sender.ack();
                this.sender.next();
                return;
            }

            this.emitAll('serialport:read', res.raw);

            // Feeder
            this.feeder.next();
        });

        this.smoothie.on('alarm', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.smoothie.on('parserstate', (res) => {
            this.actionMask.queryParserState.state = false;
            this.actionMask.queryParserState.reply = true;

            if (this.actionMask.replyParserState) {
                this.emitAll('serialport:read', res.raw);
            }
        });

        this.smoothie.on('parameters', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.smoothie.on('version', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        this.smoothie.on('others', (res) => {
            this.emitAll('serialport:read', res.raw);
        });

        // SerialPort
        this.serialport = new SerialPortWS(this.options.port, {
            autoOpen: false,
            baudrate: this.options.baudrate,
            parser: SerialPort.parsers.readline('\n')
        });

        this.serialport.on('data', (data) => {
            this.smoothie.parse('' + data);
            dbg(`[Smoothie] < ${data}`);
        });

        this.serialport.on('disconnect', (err) => {
            this.ready = false;
            if (err) {
                log.warn(`[Smoothie] Disconnected from serial port "${port}":`, err);
            }

            this.close();
        });

        this.serialport.on('error', (err) => {
            this.ready = false;
            if (err) {
                log.error(`[Smoothie] Unexpected error while reading/writing serial port "${port}":`, err);
            }
        });

        const queryStatusReport = () => {
            if (this.actionMask.queryStatusReport) {
                return;
            }

            this.actionMask.queryStatusReport = true;
            this.serialport.write('?');
        };

        const queryParserState = _.throttle(() => {
            if (this.actionMask.queryParserState.state || this.actionMask.queryParserState.reply) {
                return;
            }

            this.actionMask.queryParserState.state = true;
            this.actionMask.queryParserState.reply = false;
            this.serialport.write('$G\n');
        }, 500);

        this.queryTimer = setInterval(() => {
            if (this.isClose()) {
                // Serial port is closed
                return;
            }

            // Feeder
            if (this.feeder.peek()) {
                this.emitAll('feeder:status', this.feeder.toJSON());
            }

            // Sender
            if (this.sender.peek()) {
                this.emitAll('sender:status', this.sender.toJSON());
            }

            // Smoothie state
            if (this.state !== this.smoothie.state) {
                this.state = this.smoothie.state;
                this.emitAll('Smoothie:state', this.state);
            }

            // Do not send "?" and "$G" when Smoothie is not ready
            if (!(this.ready)) {
                // Not ready yet
                return;
            }

            // ? - Status Report
            queryStatusReport();

            // $G - Parser State
            queryParserState();
        }, 250);
    }
    clearActionMask() {
        this.actionMask.queryParserState.state = false;
        this.actionMask.queryParserState.reply = false;
        this.actionMask.queryStatusReport = false;
        this.actionMask.replyParserState = false;
        this.actionMask.replyStatusReport = false;
    }
    destroy() {
        this.connections = {};

        if (this.event) {
            this.event = null;
        }

        if (this.feeder) {
            this.feeder = null;
        }

        if (this.sender) {
            this.sender = null;
        }

        if (this.workflow) {
            this.workflow = null;
        }

        if (this.queryTimer) {
            clearInterval(this.queryTimer);
            this.queryTimer = null;
        }

        if (this.smoothie) {
            this.smoothie.removeAllListeners();
            this.smoothie = null;
        }
    }
    initController() {
        const cmds = [
            { pauseAfter: 500 },

            // Check if it is Smoothieware
            { cmd: 'version', pauseAfter: 50 }
        ];

        const sendInitCommands = (i = 0) => {
            if (i >= cmds.length) {
                this.ready = true;
                return;
            }
            const { cmd = '', pauseAfter = 0 } = { ...cmds[i] };
            if (cmd) {
                this.serialport.write(cmd + '\n');
                dbg(`[Smoothie] > ${cmd}`);
            }
            setTimeout(() => {
                sendInitCommands(i + 1);
            }, pauseAfter);
        };
        sendInitCommands();
    }
    get status() {
        return {
            port: this.options.port,
            baudrate: this.options.baudrate,
            connections: Object.keys(this.connections),
            ready: this.ready,
            controller: {
                type: this.type,
                state: this.state
            },
            workflowState: this.workflow.state,
            feeder: this.feeder.toJSON(),
            sender: this.sender.toJSON()
        };
    }
    open(callback = noop) {
        const { port, baudrate } = this.options;

        // Assertion check
        if (this.isOpen()) {
            log.error(`[Smoothie] Cannot open serial port "${port}"`);
            return;
        }

        this.serialport.open((err) => {
            if (err) {
                log.error(`[Smoothie] Error opening serial port "${port}":`, err);
                this.emitAll('serialport:error', { port: port });
                callback(err); // notify error
                return;
            }

            this.emitAll('serialport:open', {
                port: port,
                baudrate: baudrate,
                controllerType: this.type,
                inuse: true
            });

            callback(); // register controller

            log.debug(`[Smoothie] Connected to serial port "${port}"`);

            this.workflow.stop();

            // Clear action mask
            this.clearActionMask();

            // Unload G-code
            this.command(null, 'unload');

            // Initialize controller
            this.initController();
        });
    }
    close() {
        const { port } = this.options;

        // Assertion check
        if (this.isClose()) {
            log.error(`[Smoothie] Serial port "${port}" was already closed`);
            return;
        }

        this.emitAll('serialport:close', {
            port: port,
            inuse: false
        });
        store.unset('controllers["' + port + '"]');

        this.destroy();

        this.serialport.close((err) => {
            this.ready = false;
            if (err) {
                log.error(`[Smoothie] Error closing serial port "${port}":`, err);
            }
        });
    }
    isOpen() {
        return this.serialport.isOpen();
    }
    isClose() {
        return !(this.isOpen());
    }
    addConnection(socket) {
        if (!socket) {
            log.error('[Smoothie] The socket parameter is not specified');
            return;
        }

        log.debug(`[Smoothie] Add socket connection: id=${socket.id}`);
        this.connections[socket.id] = socket;

        if (!_.isEmpty(this.state)) {
            // Send controller state to a newly connected client
            socket.emit('Smoothie:state', this.state);
        }

        if (this.sender) {
            // Send sender status to a newly connected client
            socket.emit('sender:status', this.sender.toJSON());
        }
    }
    removeConnection(socket) {
        if (!socket) {
            log.error('[Smoothie] The socket parameter is not specified');
            return;
        }

        log.debug(`[Smoothie] Remove socket connection: id=${socket.id}`);
        this.connections[socket.id] = undefined;
        delete this.connections[socket.id];
    }
    emitAll(eventName, ...args) {
        Object.keys(this.connections).forEach(id => {
            const socket = this.connections[id];
            socket.emit.apply(socket, [eventName].concat(args));
        });
    }
    command(socket, cmd, ...args) {
        const handler = {
            'load': () => {
                const [name, gcode, callback = noop] = args;

                const ok = this.sender.load(name, gcode);
                if (!ok) {
                    callback(new Error(`Invalid G-code: name=${name}`));
                    return;
                }

                this.event.trigger('gcode:load');

                log.debug(`[Smoothie] Load G-code: name="${this.sender.state.name}", size=${this.sender.state.gcode.length}, total=${this.sender.state.total}`);

                this.workflow.stop();

                callback(null, { name: name, gcode: gcode });
            },
            'unload': () => {
                this.workflow.stop();

                // Sender
                this.sender.unload();

                this.event.trigger('gcode:unload');
            },
            'start': () => {
                this.event.trigger('gcode:start');

                this.workflow.start();

                // Feeder
                this.feeder.clear();

                // Sender
                this.sender.next();
            },
            'stop': () => {
                this.event.trigger('gcode:stop');

                this.workflow.stop();

                const activeState = _.get(this.state, 'status.activeState', '');
                if (activeState === SMOOTHIE_ACTIVE_STATE_HOLD) {
                    this.write(socket, '~'); // resume
                }
            },
            'pause': () => {
                this.event.trigger('gcode:pause');

                this.workflow.pause();

                this.write(socket, '!');
            },
            'resume': () => {
                this.event.trigger('gcode:resume');

                this.write(socket, '~');

                this.workflow.resume();
            },
            'feedhold': () => {
                this.event.trigger('feedhold');

                this.workflow.pause();

                this.write(socket, '!');
            },
            'cyclestart': () => {
                this.event.trigger('cyclestart');

                this.write(socket, '~');

                this.workflow.resume();
            },
            'check': () => {
                // Not supported
            },
            'homing': () => {
                this.event.trigger('homing');

                this.writeln(socket, '$H');
            },
            'sleep': () => {
                this.event.trigger('sleep');

                // Not supported
            },
            'unlock': () => {
                this.writeln(socket, '$X');
            },
            'reset': () => {
                this.workflow.stop();

                this.write(socket, '\x18'); // ^x
            },
            'feedOverride': () => {
                const [value] = args;
                let feedOverride = this.smoothie.state.status.ovF;

                if (value === 0) {
                    feedOverride = 100;
                } else if ((feedOverride + value) > 200) {
                    feedOverride = 200;
                } else if ((feedOverride + value) < 10) {
                    feedOverride = 10;
                } else {
                    feedOverride += value;
                }
                this.command(socket, 'gcode', 'M220S' + feedOverride);

                // enforce state change
                this.smoothie.state = {
                    ...this.smoothie.state,
                    status: {
                        ...this.smoothie.state.status,
                        ovF: feedOverride
                    }
                };
            },
            'spindleOverride': () => {
                const [value] = args;
                let spindleOverride = this.smoothie.state.status.ovS;

                if (value === 0) {
                    spindleOverride = 100;
                } else if ((spindleOverride + value) > 200) {
                    spindleOverride = 200;
                } else if ((spindleOverride + value) < 0) {
                    spindleOverride = 0;
                } else {
                    spindleOverride += value;
                }
                this.command(socket, 'gcode', 'M221S' + spindleOverride);

                // enforce state change
                this.smoothie.state = {
                    ...this.smoothie.state,
                    status: {
                        ...this.smoothie.state.status,
                        ovS: spindleOverride
                    }
                };
            },
            'rapidOverride': () => {
                // Not supported
            },
            'gcode': () => {
                const command = args.join(' ').split('\n');
                this.feeder.feed(command);

                if (!this.feeder.isPending()) {
                    this.feeder.next();
                }
            },
            'loadmacro': () => {
                const [id, callback = noop] = args;
                const macros = config.get('macros');
                const macro = _.find(macros, { id: id });

                if (!macro) {
                    log.error(`[Smoothie] Cannot find the macro: id=${id}`);
                    return;
                }

                this.event.trigger('loadmacro');

                this.command(null, 'load', macro.name, macro.content, callback);
            },
            'loadfile': () => {
                const [file, callback = noop] = args;

                monitor.readFile(file, (err, data) => {
                    if (err) {
                        callback(err);
                        return;
                    }

                    this.event.trigger('loadfile');

                    this.command(null, 'load', file, data, callback);
                });
            }
        }[cmd];

        if (!handler) {
            log.error(`[Smoothie] Unknown command: ${cmd}`);
            return;
        }

        handler();
    }
    write(socket, data) {
        const cmd = data.trim();
        this.actionMask.replyStatusReport = (cmd === '?') || this.actionMask.replyStatusReport;
        this.actionMask.replyParserState = (cmd === '$G') || this.actionMask.replyParserState;

        this.emitAll('serialport:write', data);
        this.serialport.write(data);
        dbg(`[Smoothie] > ${data}`);
    }
    writeln(socket, data) {
        if (_.includes(SMOOTHIE_REALTIME_COMMANDS, data)) {
            this.write(socket, data);
        } else {
            this.write(socket, data + '\n');
        }
    }
}

export default SmoothieController;
