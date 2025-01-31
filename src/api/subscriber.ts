import { URI } from "../grammar/uri.js";
import { fromBodyLegacy } from "../core/messages/body.js";
import { Logger } from "../core/log/logger.js";
import { C } from "../core/messages/methods/constants.js";
import { IncomingNotifyRequest } from "../core/messages/methods/notify.js";
import { IncomingRequestWithSubscription, OutgoingSubscribeRequest } from "../core/messages/methods/subscribe.js";
import { IncomingResponse } from "../core/messages/incoming-response.js";
import { OutgoingRequestMessage } from "../core/messages/outgoing-request-message.js";
import { RequestOptions } from "../core/messages/outgoing-request.js";
import {
  Subscription as SubscriptionDialog,
  SubscriptionState as SubscriptionDialogState
} from "../core/subscription/subscription.js";
import { UserAgentCore } from "../core/user-agent-core/user-agent-core.js";
import { AllowedMethods } from "../core/user-agent-core/allowed-methods.js";
import { Notification } from "./notification.js";
import { BodyAndContentType } from "./session-description-handler.js";
import { SubscriberOptions } from "./subscriber-options.js";
import { SubscriberSubscribeOptions } from "./subscriber-subscribe-options.js";
import { Subscription } from "./subscription.js";
import { SubscriptionState } from "./subscription-state.js";
import { SubscriptionUnsubscribeOptions } from "./subscription-unsubscribe-options.js";
import { UserAgent } from "./user-agent.js";

/**
 * A subscriber establishes a {@link Subscription} (outgoing SUBSCRIBE).
 *
 * @remarks
 * This is (more or less) an implementation of a "subscriber" as
 * defined in RFC 6665 "SIP-Specific Event Notifications".
 * https://tools.ietf.org/html/rfc6665
 *
 * @example
 * ```ts
 * // Create a new subscriber.
 * const targetURI = new URI("sip", "alice", "example.com");
 * const eventType = "example-name"; // https://www.iana.org/assignments/sip-events/sip-events.xhtml
 * const subscriber = new Subscriber(userAgent, targetURI, eventType);
 *
 * // Add delegate to handle event notifications.
 * subscriber.delegate = {
 *   onNotify: (notification: Notification) => {
 *     // send a response
 *     notification.accept();
 *     // handle notification here
 *   }
 * };
 *
 * // Monitor subscription state changes.
 * subscriber.stateChange.addListener((newState: SubscriptionState) => {
 *   if (newState === SubscriptionState.Terminated) {
 *     // handle state change here
 *   }
 * });
 *
 * // Attempt to establish the subscription
 * subscriber.subscribe();
 *
 * // Sometime later when done with subscription
 * subscriber.unsubscribe();
 * ```
 *
 * @public
 */
export class Subscriber extends Subscription {
  // TODO: Cleanup these internals
  private id: string;
  private body: BodyAndContentType | undefined = undefined;
  private event: string;
  private expires: number;
  private extraHeaders: Array<string>;
  private logger: Logger;
  private outgoingRequestMessage: OutgoingRequestMessage;
  private retryAfterTimer: number | undefined;
  private subscriberRequest: SubscriberRequest;
  private targetURI: URI;

  /**
   * Constructor.
   * @param userAgent - User agent. See {@link UserAgent} for details.
   * @param targetURI - The request URI identifying the subscribed event.
   * @param eventType - The event type identifying the subscribed event.
   * @param options - Options bucket. See {@link SubscriberOptions} for details.
   */
  public constructor(userAgent: UserAgent, targetURI: URI, eventType: string, options: SubscriberOptions = {}) {
    super(userAgent, options);

    this.logger = userAgent.getLogger("sip.Subscriber");
    if (options.body) {
      this.body = {
        body: options.body,
        contentType: options.contentType ? options.contentType : "application/sdp"
      };
    }

    this.targetURI = targetURI;

    // Subscription event
    this.event = eventType;

    // Subscription expires
    if (options.expires === undefined) {
      this.expires = 3600;
    } else if (typeof options.expires !== "number") {
      // pre-typescript type guard
      this.logger.warn(`Option "expires" must be a number. Using default of 3600.`);
      this.expires = 3600;
    } else {
      this.expires = options.expires;
    }

    // Subscription extra headers
    this.extraHeaders = (options.extraHeaders || []).slice();

    // Subscription context.
    this.subscriberRequest = this.initSubscriberRequest();

    this.outgoingRequestMessage = this.subscriberRequest.message;

    // Add to UserAgent's collection
    this.id = this.outgoingRequestMessage.callId + this.outgoingRequestMessage.from.parameters.tag + this.event;
    this._userAgent._subscriptions[this.id] = this;
  }

  /**
   * Destructor.
   * @internal
   */
  public dispose(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.logger.log(`Subscription ${this.id} in state ${this.state} is being disposed`);

    // Remove from the user agent's subscription collection
    delete this._userAgent._subscriptions[this.id];

    // Clear timers
    if (this.retryAfterTimer) {
      clearTimeout(this.retryAfterTimer);
      this.retryAfterTimer = undefined;
    }

    // Dispose subscriber request
    this.subscriberRequest.dispose();

    // Make sure to dispose of our parent, then unsubscribe the
    // subscription dialog (if need be) and resolve when it has terminated.
    return super.dispose().then(() => {
      // If we have never subscribed there is nothing to wait on.
      // If we are already transitioned to terminated there is no need to unsubscribe again.
      if (this.state !== SubscriptionState.Subscribed) {
        return;
      }
      if (!this._dialog) {
        throw new Error("Dialog undefined.");
      }
      if (
        this._dialog.subscriptionState === SubscriptionDialogState.Pending ||
        this._dialog.subscriptionState === SubscriptionDialogState.Active
      ) {
        const dialog = this._dialog;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        return new Promise((resolve, reject) => {
          dialog.delegate = {
            onTerminated: (): void => resolve()
          };
          dialog.unsubscribe();
        });
      }
    });
  }

  /**
   * Subscribe to event notifications.
   *
   * @remarks
   * Send an initial SUBSCRIBE request if no subscription as been established.
   * Sends a re-SUBSCRIBE request if the subscription is "active".
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public subscribe(options: SubscriberSubscribeOptions = {}): Promise<void> {
    switch (this.subscriberRequest.state) {
      case SubscriptionDialogState.Initial:
        // we can end up here when retrying so only state transition if in SubscriptionState.Initial state
        if (this.state === SubscriptionState.Initial) {
          this.stateTransition(SubscriptionState.NotifyWait);
        }
        this.subscriberRequest.subscribe().then((result) => {
          if (result.success) {
            if (result.success.subscription) {
              this._dialog = result.success.subscription;
              this._dialog.delegate = {
                onNotify: (request): void => this.onNotify(request),
                onRefresh: (request): void => this.onRefresh(request),
                onTerminated: (): void => {
                  // If a call to unsubscribe will state transition to SubscriptionState.Terminated,
                  // but we can end up here after that if the NOTIFY never arrives and timer N fires.
                  if (this.state !== SubscriptionState.Terminated) {
                    this.stateTransition(SubscriptionState.Terminated);
                  }
                }
              };
            }
            this.onNotify(result.success.request);
          } else if (result.failure) {
            this.unsubscribe();
          }
        });
        break;
      case SubscriptionDialogState.NotifyWait:
        break;
      case SubscriptionDialogState.Pending:
        break;
      case SubscriptionDialogState.Active:
        if (this._dialog) {
          const request = this._dialog.refresh();
          request.delegate = {
            onAccept: (response): void => this.onAccepted(response),
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            onRedirect: (response): Promise<void> => this.unsubscribe(),
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            onReject: (response): Promise<void> => this.unsubscribe()
          };
        }
        break;
      case SubscriptionDialogState.Terminated:
        break;
      default:
        break;
    }
    return Promise.resolve();
  }

  /**
   * {@inheritDoc Subscription.unsubscribe}
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public unsubscribe(options: SubscriptionUnsubscribeOptions = {}): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    switch (this.subscriberRequest.state) {
      case SubscriptionDialogState.Initial:
        break;
      case SubscriptionDialogState.NotifyWait:
        break;
      case SubscriptionDialogState.Pending:
        if (this._dialog) {
          this._dialog.unsubscribe(options);
          // responses intentionally ignored
        }
        break;
      case SubscriptionDialogState.Active:
        if (this._dialog) {
          this._dialog.unsubscribe(options);
          // responses intentionally ignored
        }
        break;
      case SubscriptionDialogState.Terminated:
        break;
      default:
        throw new Error("Unknown state.");
    }

    this.stateTransition(SubscriptionState.Terminated);
    return Promise.resolve();
  }

  /**
   * Sends a re-SUBSCRIBE request if the subscription is "active".
   * @deprecated Use `subscribe` instead.
   * @internal
   */
  public _refresh(): Promise<void> {
    if (this.subscriberRequest.state === SubscriptionDialogState.Active) {
      return this.subscribe();
    }
    return Promise.resolve();
  }

  /** @internal */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onAccepted(response: IncomingResponse): void {
    // NOTE: If you think you should do something with this response,
    // please make sure you understand what it is you are doing and why.
    // Per the RFC, the first NOTIFY is all that actually matters.
  }

  /** @internal */
  protected onNotify(request: IncomingNotifyRequest): void {
    // If we've set state to done, no further processing should take place
    // and we are only interested in cleaning up after the appropriate NOTIFY.
    if (this.disposed) {
      request.accept();
      return;
    }

    // State transition if needed.
    if (this.state !== SubscriptionState.Subscribed) {
      this.stateTransition(SubscriptionState.Subscribed);
    }

    // Delegate notification.
    if (this.delegate && this.delegate.onNotify) {
      const notification = new Notification(request);
      this.delegate.onNotify(notification);
    } else {
      request.accept();
    }

    //  If the "Subscription-State" value is SubscriptionState.Terminated, the subscriber
    //  MUST consider the subscription terminated.  The "expires" parameter
    //  has no semantics for SubscriptionState.Terminated -- notifiers SHOULD NOT include an
    //  "expires" parameter on a "Subscription-State" header field with a
    //  value of SubscriptionState.Terminated, and subscribers MUST ignore any such
    //  parameter, if present.  If a reason code is present, the client
    //  should behave as described below.  If no reason code or an unknown
    //  reason code is present, the client MAY attempt to re-subscribe at any
    //  time (unless a "retry-after" parameter is present, in which case the
    //  client SHOULD NOT attempt re-subscription until after the number of
    //  seconds specified by the "retry-after" parameter).  The reason codes
    //  defined by this document are:
    // https://tools.ietf.org/html/rfc6665#section-4.1.3
    const subscriptionState = request.message.parseHeader("Subscription-State");
    if (subscriptionState && subscriptionState.state) {
      switch (subscriptionState.state) {
        case "terminated":
          if (subscriptionState.reason) {
            this.logger.log(`Terminated subscription with reason ${subscriptionState.reason}`);
            switch (subscriptionState.reason) {
              case "deactivated":
              case "timeout":
                this.initSubscriberRequest();
                this.subscribe();
                return;
              case "probation":
              case "giveup":
                this.initSubscriberRequest();
                if (subscriptionState.params && subscriptionState.params["retry-after"]) {
                  this.retryAfterTimer = setTimeout(() => {
                    this.subscribe();
                  }, subscriptionState.params["retry-after"]);
                } else {
                  this.subscribe();
                }
                return;
              case "rejected":
              case "noresource":
              case "invariant":
                break;
            }
          }
          this.unsubscribe();
          break;
        default:
          break;
      }
    }
  }

  /** @internal */
  protected onRefresh(request: OutgoingSubscribeRequest): void {
    request.delegate = {
      onAccept: (response): void => this.onAccepted(response)
    };
  }

  private initSubscriberRequest(): SubscriberRequest {
    const options = {
      extraHeaders: this.extraHeaders,
      body: this.body ? fromBodyLegacy(this.body) : undefined
    };
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    this.subscriberRequest = new SubscriberRequest(
      this._userAgent.userAgentCore,
      this.targetURI,
      this.event,
      this.expires,
      options
    );
    this.subscriberRequest.delegate = {
      onAccept: (response): void => this.onAccepted(response)
    };
    return this.subscriberRequest;
  }
}

interface SubscriberRequestDelegate {
  /**
   * This SUBSCRIBE request will be confirmed with a final response.
   * 200-class responses indicate that the subscription has been accepted
   * and that a NOTIFY request will be sent immediately.
   * https://tools.ietf.org/html/rfc6665#section-4.1.2.1
   *
   * Called for initial SUBSCRIBE request only.
   * @param response 200-class incoming response.
   */
  onAccept?(response: IncomingResponse): void;
}

interface SubscribeResult {
  /** Exists if successfully established a subscription, otherwise undefined. */
  success?: IncomingRequestWithSubscription;
  /** Exists if failed to establish a subscription, otherwise undefined. */
  failure?: {
    /**
     * The negative final response to the SUBSCRIBE, if one was received.
     * Otherwise a timeout occurred waiting for the initial NOTIFY.
     */
    response?: IncomingResponse;
  };
}

class SubscriberRequest {
  public delegate: SubscriberRequestDelegate | undefined;
  public message: OutgoingRequestMessage;

  private logger: Logger;
  private request: OutgoingSubscribeRequest | undefined;
  private subscription: SubscriptionDialog | undefined;

  private subscribed = false;

  public constructor(
    private core: UserAgentCore,
    private target: URI,
    private event: string,
    private expires: number,
    options: RequestOptions,
    delegate?: SubscriberRequestDelegate
  ) {
    this.logger = core.loggerFactory.getLogger("sip.Subscriber");
    this.delegate = delegate;

    const allowHeader = "Allow: " + AllowedMethods.toString();
    const extraHeaders = ((options && options.extraHeaders) || []).slice();
    extraHeaders.push(allowHeader);
    extraHeaders.push("Event: " + this.event);
    extraHeaders.push("Expires: " + this.expires);
    extraHeaders.push("Contact: " + this.core.configuration.contact.toString());

    const body = options && options.body;

    this.message = core.makeOutgoingRequestMessage(
      C.SUBSCRIBE,
      this.target,
      this.core.configuration.aor,
      this.target,
      {},
      extraHeaders,
      body
    );
  }

  /** Destructor. */
  public dispose(): void {
    if (this.request) {
      this.request.waitNotifyStop();
      this.request.dispose();
      this.request = undefined;
    }
  }

  /** Subscription state. */
  public get state(): SubscriptionDialogState {
    if (this.subscription) {
      return this.subscription.subscriptionState;
    } else if (this.subscribed) {
      return SubscriptionDialogState.NotifyWait;
    } else {
      return SubscriptionDialogState.Initial;
    }
  }

  /**
   * Establish subscription.
   * @param options Options bucket.
   */
  public subscribe(): Promise<SubscribeResult> {
    if (this.subscribed) {
      return Promise.reject(new Error("Not in initial state. Did you call subscribe more than once?"));
    }
    this.subscribed = true;

    return new Promise((resolve) => {
      if (!this.message) {
        throw new Error("Message undefined.");
      }
      this.request = this.core.subscribe(this.message, {
        // This SUBSCRIBE request will be confirmed with a final response.
        // 200-class responses indicate that the subscription has been accepted
        // and that a NOTIFY request will be sent immediately.
        // https://tools.ietf.org/html/rfc6665#section-4.1.2.1
        onAccept: (response) => {
          if (this.delegate && this.delegate.onAccept) {
            this.delegate.onAccept(response);
          }
        },
        // Due to the potential for out-of-order messages, packet loss, and
        // forking, the subscriber MUST be prepared to receive NOTIFY requests
        // before the SUBSCRIBE transaction has completed.
        // https://tools.ietf.org/html/rfc6665#section-4.1.2.4
        onNotify: (requestWithSubscription): void => {
          this.subscription = requestWithSubscription.subscription;
          if (this.subscription) {
            this.subscription.autoRefresh = true;
          }
          resolve({ success: requestWithSubscription });
        },
        // If this Timer N expires prior to the receipt of a NOTIFY request,
        // the subscriber considers the subscription failed, and cleans up
        // any state associated with the subscription attempt.
        // https://tools.ietf.org/html/rfc6665#section-4.1.2.4
        onNotifyTimeout: () => {
          resolve({ failure: {} });
        },
        // This SUBSCRIBE request will be confirmed with a final response.
        // Non-200-class final responses indicate that no subscription or new
        // dialog usage has been created, and no subsequent NOTIFY request will
        // be sent.
        // https://tools.ietf.org/html/rfc6665#section-4.1.2.1
        onRedirect: (response) => {
          resolve({ failure: { response } });
        },
        // This SUBSCRIBE request will be confirmed with a final response.
        // Non-200-class final responses indicate that no subscription or new
        // dialog usage has been created, and no subsequent NOTIFY request will
        // be sent.
        // https://tools.ietf.org/html/rfc6665#section-4.1.2.1
        onReject: (response) => {
          resolve({ failure: { response } });
        }
      });
    });
  }
}
