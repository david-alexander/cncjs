import classNames from 'classnames';
import pubsub from 'pubsub-js';
import React, { Component, PropTypes } from 'react';
import shallowCompare from 'react-addons-shallow-compare';
import api from '../../api';
import Widget from '../../components/Widget';
import controller from '../../lib/controller';
import i18n from '../../lib/i18n';
import store from '../../store';
import Macro from './Macro';
import {
    MODAL_STATE_NONE
} from './constants';
import styles from './index.styl';

class MacroWidget extends Component {
    static propTypes = {
        onDelete: PropTypes.func,
        sortable: PropTypes.object
    };
    static defaultProps = {
        onDelete: () => {}
    };

    pubsubTokens = [];

    constructor() {
        super();
        this.state = this.getDefaultState();
    }
    componentDidMount() {
        this.subscribe();

        // Fetch the list of macros
        this.listMacros();
    }
    componentWillUnmount() {
        this.unsubscribe();
    }
    shouldComponentUpdate(nextProps, nextState) {
        return shallowCompare(this, nextProps, nextState);
    }
    componentDidUpdate(prevProps, prevState) {
        const {
            minimized
        } = this.state;

        store.set('widgets.macro.minimized', minimized);
    }
    getDefaultState() {
        return {
            minimized: store.get('widgets.macro.minimized', false),
            isFullscreen: false,
            port: controller.port,
            workflowState: controller.workflowState,
            macros: [],
            modalState: MODAL_STATE_NONE,
            modalParams: {}
        };
    }
    subscribe() {
        const tokens = [
            pubsub.subscribe('port', (msg, port) => {
                port = port || '';

                if (port) {
                    this.setState({ port: port });
                } else {
                    this.setState({ port: '' });
                }
            }),
            pubsub.subscribe('workflowState', (msg, workflowState) => {
                this.setState({ workflowState: workflowState });
            })
        ];
        this.pubsubTokens = this.pubsubTokens.concat(tokens);
    }
    unsubscribe() {
        this.pubsubTokens.forEach((token) => {
            pubsub.unsubscribe(token);
        });
        this.pubsubTokens = [];
    }
    openModal(modalState = MODAL_STATE_NONE, modalParams = {}) {
        this.setState({
            modalState: modalState,
            modalParams: modalParams
        });
    }
    closeModal() {
        this.setState({
            modalState: MODAL_STATE_NONE,
            modalParams: {}
        });
    }
    async listMacros() {
        try {
            let res;
            res = await api.listMacros();
            const macros = res.body;
            this.setState({ macros: macros });
        } catch (err) {
            // Ignore error
        }
    }
    async addMacro({ name, content }) {
        try {
            let res;
            res = await api.addMacro({ name, content });
            res = await api.listMacros();
            const macros = res.body;
            this.setState({ macros: macros });
        } catch (err) {
            // Ignore error
        }
    }
    async deleteMacro({ id }) {
        try {
            let res;
            res = await api.deleteMacro({ id });
            res = await api.listMacros();
            const macros = res.body;
            this.setState({ macros: macros });
        } catch (err) {
            // Ignore error
        }
    }
    async updateMacro({ id, name, content }) {
        try {
            let res;
            res = await api.updateMacro({ id, name, content });
            res = await api.listMacros();
            const macros = res.body;
            this.setState({ macros: macros });
        } catch (err) {
            // Ignore error
        }
    }
    render() {
        const { minimized, isFullscreen } = this.state;
        const state = {
            ...this.state
        };
        const actions = {
            openModal: ::this.openModal,
            closeModal: ::this.closeModal,
            addMacro: ::this.addMacro,
            updateMacro: ::this.updateMacro,
            deleteMacro: ::this.deleteMacro
        };

        return (
            <Widget fullscreen={isFullscreen}>
                <Widget.Header className={this.props.sortable.handleClassName}>
                    <Widget.Title>{i18n._('Macro')}</Widget.Title>
                    <Widget.Controls className={this.props.sortable.filterClassName}>
                        <Widget.Button
                            title={minimized ? i18n._('Open') : i18n._('Close')}
                            onClick={(event, val) => this.setState({ minimized: !minimized })}
                        >
                            <i
                                className={classNames(
                                    'fa',
                                    { 'fa-chevron-up': !minimized },
                                    { 'fa-chevron-down': minimized }
                                )}
                            />
                        </Widget.Button>
                        <Widget.Button
                            title={i18n._('Fullscreen')}
                            onClick={(event, val) => this.setState({ isFullscreen: !isFullscreen })}
                        >
                            <i
                                className={classNames(
                                    'fa',
                                    { 'fa-expand': !isFullscreen },
                                    { 'fa-compress': isFullscreen }
                                )}
                            />
                        </Widget.Button>
                        <Widget.Button
                            title={i18n._('Remove')}
                            onClick={(event) => this.props.onDelete()}
                        >
                            <i className="fa fa-times" />
                        </Widget.Button>
                    </Widget.Controls>
                </Widget.Header>
                <Widget.Content
                    className={classNames(
                        styles['widget-content'],
                        { [styles.hidden]: minimized }
                    )}
                >
                    <Macro
                        state={state}
                        actions={actions}
                    />
                </Widget.Content>
            </Widget>
        );
    }
}

export default MacroWidget;
