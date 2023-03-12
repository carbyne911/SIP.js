import { URI } from "../grammar/uri.js";
import { Body, fromBodyLegacy } from "../core/messages/body.js";
import { C } from "../core/messages/methods/constants.js";
import { Logger } from "../core/log/logger.js";
import { OutgoingRequestMessage } from "../core/messages/outgoing-request-message.js";
import { IncomingResponseMessage } from "../core/messages/incoming-response-message.js";
import { OutgoingPublishRequest } from "../core/messages/methods/publish.js";
import { Emitter, EmitterImpl } from "./emitter.js";
import { PublisherOptions } from "./publisher-options.js";
import { PublisherPublishOptions } from "./publisher-publish-options.js";
import { PublisherState } from "./publisher-state.js";
import { PublisherUnpublishOptions } from "./publisher-unpublish-options.js";
import { BodyAndContentType } from "./session-description-handler.js";
import { UserAgent } from "./user-agent.js";

/**
 * A publisher publishes a publication (outgoing PUBLISH).
 * @public
 */
export class Publisher {
  private event: string;
  private options: PublisherOptions;
  private target: URI;
  private pubRequestBody: string | undefined;
  private pubRequestExpires: number;
  private pubRequestEtag: string | undefined;
  private publishRefreshTimer: number | undefined;

  private disposed = false;
  private id: string;
  private logger: Logger;
  private request: OutgoingRequestMessage;
  private userAgent: UserAgent;

  /** The publication state. */
  private _state: PublisherState = PublisherState.Initial;
  /** Emits when the registration state changes. */
  private _stateEventEmitter: EmitterImpl<PublisherState>;

  /**
   * Constructs a new instance of the `Publisher` class.
   *
   * @param userAgent - User agent. See {@link UserAgent} for details.
   * @param targetURI - Request URI identifying the target of the message.
   * @param eventType - The event type identifying the published document.
   * @param options - Options bucket. See {@link PublisherOptions} for details.
   */
  public constructor(userAgent: UserAgent, targetURI: URI, eventType: string, options: PublisherOptions = {}) {
    // state emitter
    this._stateEventEmitter = new EmitterImpl<PublisherState>();

    this.userAgent = userAgent;

    options.extraHeaders = (options.extraHeaders || []).slice();
    options.contentType = options.contentType || "text/plain";

    if (typeof options.expires !== "number" || options.expires % 1 !== 0) {
      options.expires = 3600;
    } else {
      options.expires = Number(options.expires);
    }

    if (typeof options.unpublishOnClose !== "boolean") {
      options.unpublishOnClose = true;
    }

    this.target = targetURI;
    this.event = eventType;
    this.options = options;
    this.pubRequestExpires = options.expires;

    this.logger = userAgent.getLogger("sip.Publisher");

    const params = options.params || {};
    const fromURI = params.fromUri ? params.fromUri : userAgent.userAgentCore.configuration.aor;
    const toURI = params.toUri ? params.toUri : targetURI;
    let body: Body | undefined;
    if (options.body && options.contentType) {
      const contentDisposition = "render";
      const contentType = options.contentType;
      const content = options.body;
      body = {
        contentDisposition,
        contentType,
        content
      };
    }
    const extraHeaders = (options.extraHeaders || []).slice();

    // Build the request
    this.request = userAgent.userAgentCore.makeOutgoingRequestMessage(
      C.PUBLISH,
      targetURI,
      fromURI,
      toURI,
      params,
      extraHeaders,
      body
    );

    // Identifier
    this.id = this.target.toString() + ":" + this.event;

    // Add to the user agent's publisher collection.
    this.userAgent._publishers[this.id] = this;
  }

  /**
   * Destructor.
   */
  public dispose(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    this.disposed = true;
    this.logger.log(`Publisher ${this.id} in state ${this.state} is being disposed`);

    // Remove from the user agent's publisher collection
    delete this.userAgent._publishers[this.id];

    // Send unpublish, if requested
    if (this.options.unpublishOnClose && this.state === PublisherState.Published) {
      return this.unpublish();
    }

    if (this.publishRefreshTimer) {
      clearTimeout(this.publishRefreshTimer);
      this.publishRefreshTimer = undefined;
    }

    this.pubRequestBody = undefined;
    this.pubRequestExpires = 0;
    this.pubRequestEtag = undefined;

    return Promise.resolve();
  }

  /** The publication state. */
  public get state(): PublisherState {
    return this._state;
  }

  /** Emits when the publisher state changes. */
  public get stateChange(): Emitter<PublisherState> {
    return this._stateEventEmitter;
  }

  /**
   * Publish.
   * @param content - Body to publish
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public publish(content: string, options: PublisherPublishOptions = {}): Promise<void> {
    // Clean up before the run
    if (this.publishRefreshTimer) {
      clearTimeout(this.publishRefreshTimer);
      this.publishRefreshTimer = undefined;
    }

    // is Initial or Modify request
    this.options.body = content;
    this.pubRequestBody = this.options.body;

    if (this.pubRequestExpires === 0) {
      // This is Initial request after unpublish
      if (this.options.expires === undefined) {
        throw new Error("Expires undefined.");
      }
      this.pubRequestExpires = this.options.expires;
      this.pubRequestEtag = undefined;
    }

    this.sendPublishRequest();

    return Promise.resolve();
  }

  /**
   * Unpublish.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public unpublish(options: PublisherUnpublishOptions = {}): Promise<void> {
    // Clean up before the run
    if (this.publishRefreshTimer) {
      clearTimeout(this.publishRefreshTimer);
      this.publishRefreshTimer = undefined;
    }

    this.pubRequestBody = undefined;
    this.pubRequestExpires = 0;

    if (this.pubRequestEtag !== undefined) {
      this.sendPublishRequest();
    }

    return Promise.resolve();
  }

  /** @internal */
  protected receiveResponse(response: IncomingResponseMessage): void {
    const statusCode: number = response.statusCode || 0;

    switch (true) {
      case /^1[0-9]{2}$/.test(statusCode.toString()):
        break;
      case /^2[0-9]{2}$/.test(statusCode.toString()):
        // Set SIP-Etag
        if (response.hasHeader("SIP-ETag")) {
          this.pubRequestEtag = response.getHeader("SIP-ETag");
        } else {
          this.logger.warn("SIP-ETag header missing in a 200-class response to PUBLISH");
        }

        // Update Expire
        if (response.hasHeader("Expires")) {
          const expires = Number(response.getHeader("Expires"));
          if (typeof expires === "number" && expires >= 0 && expires <= this.pubRequestExpires) {
            this.pubRequestExpires = expires;
          } else {
            this.logger.warn("Bad Expires header in a 200-class response to PUBLISH");
          }
        } else {
          this.logger.warn("Expires header missing in a 200-class response to PUBLISH");
        }

        if (this.pubRequestExpires !== 0) {
          // Schedule refresh
          this.publishRefreshTimer = setTimeout(() => this.refreshRequest(), this.pubRequestExpires * 900);
          if (this._state !== PublisherState.Published) {
            this.stateTransition(PublisherState.Published);
          }
        } else {
          this.stateTransition(PublisherState.Unpublished);
        }
        break;
      case /^412$/.test(statusCode.toString()):
        // 412 code means no matching ETag - possibly the PUBLISH expired
        // Resubmit as new request, if the current request is not a "remove"

        if (this.pubRequestEtag !== undefined && this.pubRequestExpires !== 0) {
          this.logger.warn("412 response to PUBLISH, recovering");
          this.pubRequestEtag = undefined;
          if (this.options.body === undefined) {
            throw new Error("Body undefined.");
          }
          this.publish(this.options.body);
        } else {
          this.logger.warn("412 response to PUBLISH, recovery failed");
          this.pubRequestExpires = 0;
          this.stateTransition(PublisherState.Unpublished);
          this.stateTransition(PublisherState.Terminated);
        }
        break;
      case /^423$/.test(statusCode.toString()):
        // 423 code means we need to adjust the Expires interval up
        if (this.pubRequestExpires !== 0 && response.hasHeader("Min-Expires")) {
          const minExpires = Number(response.getHeader("Min-Expires"));
          if (typeof minExpires === "number" || minExpires > this.pubRequestExpires) {
            this.logger.warn("423 code in response to PUBLISH, adjusting the Expires value and trying to recover");
            this.pubRequestExpires = minExpires;
            if (this.options.body === undefined) {
              throw new Error("Body undefined.");
            }
            this.publish(this.options.body);
          } else {
            this.logger.warn("Bad 423 response Min-Expires header received for PUBLISH");
            this.pubRequestExpires = 0;
            this.stateTransition(PublisherState.Unpublished);
            this.stateTransition(PublisherState.Terminated);
          }
        } else {
          this.logger.warn("423 response to PUBLISH, recovery failed");
          this.pubRequestExpires = 0;
          this.stateTransition(PublisherState.Unpublished);
          this.stateTransition(PublisherState.Terminated);
        }
        break;
      default:
        this.pubRequestExpires = 0;
        this.stateTransition(PublisherState.Unpublished);
        this.stateTransition(PublisherState.Terminated);
        break;
    }

    // Do the cleanup
    if (this.pubRequestExpires === 0) {
      if (this.publishRefreshTimer) {
        clearTimeout(this.publishRefreshTimer);
        this.publishRefreshTimer = undefined;
      }

      this.pubRequestBody = undefined;
      this.pubRequestEtag = undefined;
    }
  }

  /** @internal */
  protected send(): OutgoingPublishRequest {
    return this.userAgent.userAgentCore.publish(this.request, {
      onAccept: (response): void => this.receiveResponse(response.message),
      onProgress: (response): void => this.receiveResponse(response.message),
      onRedirect: (response): void => this.receiveResponse(response.message),
      onReject: (response): void => this.receiveResponse(response.message),
      onTrying: (response): void => this.receiveResponse(response.message)
    });
  }

  private refreshRequest(): void {
    // Clean up before the run
    if (this.publishRefreshTimer) {
      clearTimeout(this.publishRefreshTimer);
      this.publishRefreshTimer = undefined;
    }

    // This is Refresh request
    this.pubRequestBody = undefined;

    if (this.pubRequestEtag === undefined) {
      throw new Error("Etag undefined");
    }

    if (this.pubRequestExpires === 0) {
      throw new Error("Expires zero");
    }

    this.sendPublishRequest();
  }

  private sendPublishRequest(): OutgoingPublishRequest {
    const reqOptions = { ...this.options };

    reqOptions.extraHeaders = (this.options.extraHeaders || []).slice();

    reqOptions.extraHeaders.push("Event: " + this.event);
    reqOptions.extraHeaders.push("Expires: " + this.pubRequestExpires);

    if (this.pubRequestEtag !== undefined) {
      reqOptions.extraHeaders.push("SIP-If-Match: " + this.pubRequestEtag);
    }

    const ruri = this.target;
    const params = this.options.params || {};
    let bodyAndContentType: BodyAndContentType | undefined;
    if (this.pubRequestBody !== undefined) {
      if (this.options.contentType === undefined) {
        throw new Error("Content type undefined.");
      }
      bodyAndContentType = {
        body: this.pubRequestBody,
        contentType: this.options.contentType
      };
    }
    let body: Body | undefined;
    if (bodyAndContentType) {
      body = fromBodyLegacy(bodyAndContentType);
    }

    this.request = this.userAgent.userAgentCore.makeOutgoingRequestMessage(
      C.PUBLISH,
      ruri,
      params.fromUri ? params.fromUri : this.userAgent.userAgentCore.configuration.aor,
      params.toUri ? params.toUri : this.target,
      params,
      reqOptions.extraHeaders,
      body
    );

    return this.send();
  }

  /**
   * Transition publication state.
   */
  private stateTransition(newState: PublisherState): void {
    const invalidTransition = (): void => {
      throw new Error(`Invalid state transition from ${this._state} to ${newState}`);
    };

    // Validate transition
    switch (this._state) {
      case PublisherState.Initial:
        if (
          newState !== PublisherState.Published &&
          newState !== PublisherState.Unpublished &&
          newState !== PublisherState.Terminated
        ) {
          invalidTransition();
        }
        break;
      case PublisherState.Published:
        if (newState !== PublisherState.Unpublished && newState !== PublisherState.Terminated) {
          invalidTransition();
        }
        break;
      case PublisherState.Unpublished:
        if (newState !== PublisherState.Published && newState !== PublisherState.Terminated) {
          invalidTransition();
        }
        break;
      case PublisherState.Terminated:
        invalidTransition();
        break;
      default:
        throw new Error("Unrecognized state.");
    }

    // Transition
    this._state = newState;
    this.logger.log(`Publication transitioned to state ${this._state}`);
    this._stateEventEmitter.emit(this._state);

    // Dispose
    if (newState === PublisherState.Terminated) {
      this.dispose();
    }
  }
}
