import classNames from 'classnames';
import React, { Component, PropTypes } from 'react';
import { Nav, Navbar, NavDropdown, MenuItem, OverlayTrigger, Tooltip } from 'react-bootstrap';
import semver from 'semver';
import without from 'lodash/without';
import Push from 'push.js';
import api from '../../api';
import Anchor from '../../components/Anchor';
import settings from '../../config/settings';
import confirm from '../../lib/confirm';
import controller from '../../lib/controller';
import i18n from '../../lib/i18n';
import store from '../../store';
import QuickAccessToolbar from './QuickAccessToolbar';
import styles from './index.styl';

const releases = 'https://github.com/cncjs/cncjs/releases';

const newUpdateAvailableTooltip = () => {
    return (
        <Tooltip
            id="navbarBrandTooltip"
            style={{ color: '#fff' }}
        >
            <div>{i18n._('New update available')}</div>
        </Tooltip>
    );
};

class Header extends Component {
    static propTypes = {
        path: PropTypes.string
    };

    state = {
        pushPermission: Push.Permission.get(),
        commands: [],
        runningTasks: [],
        currentVersion: settings.version,
        latestVersion: settings.version
    };
    actions = {
        requestPushPermission: () => {
            const onGranted = () => {
                this.setState({ pushPermission: Push.Permission.GRANTED });
            };
            const onDenied = () => {
                this.setState({ pushPermission: Push.Permission.DENIED });
            };
            // Note that if "Permission.DEFAULT" is returned, no callback is executed
            const permission = Push.Permission.request(onGranted, onDenied);
            if (permission === Push.Permission.DEFAULT) {
                this.setState({ pushPermission: Push.Permission.DEFAULT });
            }
        },
        checkForUpdates: async () => {
            try {
                const res = await api.getState();
                const { checkForUpdates } = res.body;

                if (checkForUpdates) {
                    const res = await api.getLatestVersion();
                    const { time, version } = res.body;

                    this.setState({
                        latestVersion: version,
                        latestTime: time
                    });
                }
            } catch (res) {
                // Ignore error
            }
        },
        getCommands: async () => {
            try {
                const res = await api.commands.getCommands();
                const { commands = [] } = res.body;

                this.setState({ commands: commands });
            } catch (res) {
                // Ignore error
            }
        },
        runCommand: async (cmd) => {
            try {
                const res = await api.commands.runCommand({ id: cmd.id });
                const { taskId } = res.body;

                this.setState({
                    commands: this.state.commands.map(c => {
                        return (c.id === cmd.id) ? { ...c, taskId: taskId, err: null } : c;
                    })
                });
            } catch (res) {
                // Ignore error
            }
        }
    };
    controllerEvents = {
        'task:start': (taskId) => {
            this.setState({
                runningTasks: this.state.runningTasks.concat(taskId)
            });
        },
        'task:finish': (taskId, code) => {
            const err = (code !== 0) ? new Error(`errno=${code}`) : null;
            let cmd = null;

            this.setState({
                commands: this.state.commands.map(c => {
                    if (c.taskId !== taskId) {
                        return c;
                    }
                    cmd = c;
                    return {
                        ...c,
                        taskId: null,
                        err: err
                    };
                }),
                runningTasks: without(this.state.runningTasks, taskId)
            });

            if (cmd && this.state.pushPermission === Push.Permission.GRANTED) {
                Push.create(cmd.title, {
                    body: code === 0
                        ? i18n._('Command succeeded')
                        : i18n._('Command failed ({{err}})', { err: err }),
                    icon: 'images/logo-badge-32x32.png',
                    timeout: 10 * 1000,
                    onClick: function () {
                        window.focus();
                        this.close();
                    }
                });
            }
        },
        'task:error': (taskId, err) => {
            let cmd = null;

            this.setState({
                commands: this.state.commands.map(c => {
                    if (c.taskId !== taskId) {
                        return c;
                    }
                    cmd = c;
                    return {
                        ...c,
                        taskId: null,
                        err: err
                    };
                }),
                runningTasks: without(this.state.runningTasks, taskId)
            });

            if (cmd && this.state.pushPermission === Push.Permission.GRANTED) {
                Push.create(cmd.title, {
                    body: i18n._('Command failed ({{err}})', { err: err }),
                    icon: 'images/logo-badge-32x32.png',
                    timeout: 10 * 1000,
                    onClick: function () {
                        window.focus();
                        this.close();
                    }
                });
            }
        },
        'config:change': () => {
            this.actions.getCommands();
        }
    };

    componentDidMount() {
        this.addControllerEvents();

        // Initial actions
        this.actions.checkForUpdates();
        this.actions.getCommands();
    }
    componentWillUnmount() {
        this.removeControllerEvents();

        this.runningTasks = [];
    }
    addControllerEvents() {
        Object.keys(this.controllerEvents).forEach(eventName => {
            const callback = this.controllerEvents[eventName];
            controller.on(eventName, callback);
        });
    }
    removeControllerEvents() {
        Object.keys(this.controllerEvents).forEach(eventName => {
            const callback = this.controllerEvents[eventName];
            controller.off(eventName, callback);
        });
    }
    handleRestoreDefaults() {
        confirm({
            title: i18n._('Restore Defaults'),
            body: i18n._('Are you sure you want to restore the default settings?')
        }).then(() => {
            store.clear();
            window.location.reload();
        });
    }
    render() {
        const { path } = this.props;
        const { pushPermission, commands, runningTasks, currentVersion, latestVersion } = this.state;
        const newUpdateAvailable = semver.lt(currentVersion, latestVersion);
        const tooltip = newUpdateAvailable ? newUpdateAvailableTooltip() : <div />;
        const sessionEnabled = store.get('session.enabled');
        const signedInName = store.get('session.name');
        const hideUserDropdown = !sessionEnabled;
        const showCommands = commands.length > 0;

        return (
            <Navbar
                fixedTop
                fluid
                inverse
            >
                <Navbar.Header>
                    <OverlayTrigger
                        overlay={tooltip}
                        placement="right"
                    >
                        <Anchor
                            className="navbar-brand"
                            style={{
                                padding: 0,
                                position: 'relative',
                                height: 50,
                                width: 60
                            }}
                            href={releases}
                            target="_blank"
                            title={`${settings.name} ${settings.version}`}
                        >
                            <img
                                src="images/logo-badge-32x32.png"
                                role="presentation"
                                style={{
                                    margin: '4px auto 0 auto'
                                }}
                            />
                            <div
                                style={{
                                    fontSize: '50%',
                                    lineHeight: '14px',
                                    textAlign: 'center'
                                }}
                            >
                                {settings.version}
                            </div>
                            {newUpdateAvailable &&
                            <span
                                className="label label-primary"
                                style={{
                                    fontSize: '50%',
                                    position: 'absolute',
                                    top: 2,
                                    right: 2
                                }}
                            >
                                N
                            </span>
                            }
                        </Anchor>
                    </OverlayTrigger>
                    <Navbar.Toggle />
                </Navbar.Header>
                <Navbar.Collapse>
                    <Nav pullRight>
                        <NavDropdown
                            className={classNames(
                                { 'hidden': hideUserDropdown }
                            )}
                            id="nav-dropdown-user"
                            title={
                                <div title={i18n._('Account')}>
                                    <i className="fa fa-fw fa-user" />
                                </div>
                            }
                            noCaret
                        >
                            <MenuItem header>
                                {i18n._('Signed in as {{name}}', { name: signedInName })}
                            </MenuItem>
                            <MenuItem divider />
                            <MenuItem
                                href="#/settings/account"
                            >
                                <i className="fa fa-fw fa-user" />
                                <span className="space" />
                                {i18n._('Account')}
                            </MenuItem>
                            <MenuItem
                                href="#/logout"
                            >
                                <i className="fa fa-fw fa-sign-out" />
                                <span className="space" />
                                {i18n._('Sign Out')}
                            </MenuItem>
                        </NavDropdown>
                        <NavDropdown
                            id="nav-dropdown-menu"
                            title={
                                <div title={i18n._('Options')}>
                                    <i className="fa fa-fw fa-ellipsis-v" />
                                    {this.state.runningTasks.length > 0 &&
                                    <span
                                        className="label label-primary"
                                        style={{
                                            position: 'absolute',
                                            top: 4,
                                            right: 4
                                        }}
                                    >
                                        N
                                    </span>
                                    }
                                </div>
                            }
                            noCaret
                        >
                            {showCommands &&
                            <MenuItem header>
                                {i18n._('Command')}
                                {pushPermission === Push.Permission.GRANTED &&
                                <span className="pull-right">
                                    <i className="fa fa-fw fa-bell-o" />
                                </span>
                                }
                                {pushPermission === Push.Permission.DENIED &&
                                <span className="pull-right">
                                    <i className="fa fa-fw fa-bell-slash-o" />
                                </span>
                                }
                                {pushPermission === Push.Permission.DEFAULT &&
                                <span className="pull-right">
                                    <Anchor
                                        className={styles.btnIcon}
                                        onClick={this.actions.requestPushPermission}
                                        title={i18n._('Show notifications')}
                                    >
                                        <i className="fa fa-fw fa-bell" />
                                    </Anchor>
                                </span>
                                }
                            </MenuItem>
                            }
                            {showCommands && commands.map((cmd) => {
                                const isTaskRunning = runningTasks.indexOf(cmd.taskId) >= 0;

                                return (
                                    <MenuItem
                                        key={cmd.id}
                                        disabled={cmd.disabled}
                                        onSelect={() => {
                                            this.actions.runCommand(cmd);
                                        }}
                                    >
                                        <span title={cmd.command}>{cmd.title || cmd.command}</span>
                                        <span className="pull-right">
                                            <i
                                                className={classNames(
                                                    'fa',
                                                    'fa-fw',
                                                    { 'fa-circle-o-notch': isTaskRunning },
                                                    { 'fa-spin': isTaskRunning },
                                                    { 'fa-exclamation-circle': cmd.err },
                                                    { 'text-error': cmd.err }
                                                )}
                                                title={cmd.err}
                                            />
                                        </span>
                                    </MenuItem>
                                );
                            })}
                            {showCommands &&
                            <MenuItem divider />
                            }
                            <MenuItem
                                href="https://github.com/cncjs/cncjs/wiki"
                                target="_blank"
                            >
                                {i18n._('Help')}
                            </MenuItem>
                            <MenuItem
                                href="https://github.com/cncjs/cncjs/issues"
                                target="_blank"
                            >
                                {i18n._('Report an issue')}
                            </MenuItem>
                        </NavDropdown>
                    </Nav>
                    {path === 'workspace' &&
                    <QuickAccessToolbar />
                    }
                </Navbar.Collapse>
            </Navbar>
        );
    }
}

export default Header;
