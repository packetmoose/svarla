package main

import (
	"log"

	"github.com/packetmoose/svarla/modem-gateway/internal/buffer"
	"github.com/packetmoose/svarla/modem-gateway/internal/signaling"
	"github.com/packetmoose/svarla/modem-gateway/internal/sms"
	"github.com/packetmoose/svarla/modem-gateway/internal/ussd"
)

// dispatchSignalingMessage routes incoming signaling messages to the appropriate handler.
func dispatchSignalingMessage(
	msg signaling.Message,
	smsMgr *sms.Manager,
	ussdMgr *ussd.Manager,
	callMgr *signaling.CallManager,
	client signaling.MessageSender,
) {
	switch msg.Type {
	case signaling.TypeSendSMS:
		if smsMgr != nil {
			handleSendSMS(msg, smsMgr, client)
		}
	case signaling.TypeUSSDRequest:
		if ussdMgr != nil {
			handleUSSDRequest(msg, ussdMgr, client)
		}
	case signaling.TypeMakeCall, signaling.TypeAnswerCall, signaling.TypeEndCall:
		if callMgr != nil {
			callMgr.HandleMessage(msg)
		}
	}
}

// handleReconnect is called when signaling reconnects. It re-reports the number
// and delivers any buffered messages.
func handleReconnect(
	sigClient *signaling.ReconnectingClient,
	numberReporter *signaling.NumberReporter,
	missedCallBuf *signaling.MissedCallBuffer,
	smsBuffer *buffer.PersistentBuffer[sms.IncomingSMS],
) {
	log.Println("Signaling connected — delivering buffered data")

	if numberReporter != nil {
		numberReporter.ReportOnConnect()
	}

	if missedCallBuf != nil {
		if err := missedCallBuf.DeliverAll(sigClient); err != nil {
			log.Printf("Failed to deliver buffered missed calls: %v", err)
		}
	}

	if smsBuffer != nil {
		buffered, err := smsBuffer.DrainAll()
		if err != nil {
			log.Printf("Failed to drain SMS buffer: %v", err)
		}
		var failedItems []sms.IncomingSMS
		for _, incoming := range buffered {
			payload := struct {
				Type      string `json:"type"`
				MessageID string `json:"messageId"`
				From      string `json:"from"`
				Body      string `json:"body"`
				Timestamp int64  `json:"timestamp"`
			}{
				Type:      signaling.TypeBufferedSMS,
				MessageID: incoming.MessageID,
				From:      incoming.From,
				Body:      incoming.Body,
				Timestamp: incoming.Timestamp.UnixMilli(),
			}
			msg, err := signaling.NewMessage(signaling.TypeBufferedSMS, payload)
			if err != nil {
				log.Printf("Failed to create buffered_sms message: %v", err)
				failedItems = append(failedItems, incoming)
				continue
			}
			if err := sigClient.Send(msg); err != nil {
				log.Printf("Failed to send buffered_sms: %v", err)
				failedItems = append(failedItems, incoming)
			}
		}
		// Re-push any items that failed to send so they survive for next reconnect.
		for _, item := range failedItems {
			_ = smsBuffer.Push(item)
		}
	}
}

// handleSendSMS processes a send_sms message from Svarla.
func handleSendSMS(msg signaling.Message, smsMgr *sms.Manager, client signaling.MessageSender) {
	var payload struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		To        string `json:"to"`
		Body      string `json:"body"`
	}
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("Failed to parse send_sms payload: %v", err)
		return
	}

	ref, err := smsMgr.Send(payload.To, payload.Body)

	result := struct {
		Type       string `json:"type"`
		RequestID  string `json:"requestId"`
		Success    bool   `json:"success"`
		MessageRef int    `json:"messageRef,omitempty"`
		Error      string `json:"error,omitempty"`
	}{
		Type:      signaling.TypeSMSResult,
		RequestID: payload.RequestID,
	}

	if err != nil {
		result.Success = false
		result.Error = err.Error()
	} else {
		result.Success = true
		result.MessageRef = ref
	}

	respMsg, err := signaling.NewMessage(signaling.TypeSMSResult, result)
	if err != nil {
		log.Printf("Failed to create sms_result message: %v", err)
		return
	}
	if err := client.Send(respMsg); err != nil {
		log.Printf("Failed to send sms_result: %v", err)
	}
}

// handleUSSDRequest processes a ussd_request message from Svarla.
func handleUSSDRequest(msg signaling.Message, ussdMgr *ussd.Manager, client signaling.MessageSender) {
	var payload struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Code      string `json:"code"`
		Input     string `json:"input"`
		Cancel    bool   `json:"cancel"`
	}
	if err := msg.ParsePayload(&payload); err != nil {
		log.Printf("Failed to parse ussd_request payload: %v", err)
		return
	}

	if payload.Cancel {
		err := ussdMgr.Cancel()
		if err != nil {
			sendUSSDError(client, payload.RequestID, err.Error())
		}
		return
	}

	var resp *ussd.Response
	var err error
	if payload.Input != "" {
		resp, err = ussdMgr.SendInput(payload.Input)
	} else {
		resp, err = ussdMgr.Execute(payload.Code)
	}

	if err != nil {
		sendUSSDError(client, payload.RequestID, err.Error())
		return
	}

	response := struct {
		Type          string `json:"type"`
		RequestID     string `json:"requestId"`
		Text          string `json:"text"`
		SessionActive bool   `json:"sessionActive"`
	}{
		Type:          signaling.TypeUSSDResponse,
		RequestID:     payload.RequestID,
		Text:          resp.Text,
		SessionActive: resp.SessionActive,
	}

	respMsg, err := signaling.NewMessage(signaling.TypeUSSDResponse, response)
	if err != nil {
		log.Printf("Failed to create ussd_response message: %v", err)
		return
	}
	if err := client.Send(respMsg); err != nil {
		log.Printf("Failed to send ussd_response: %v", err)
	}
}

// sendUSSDError sends a ussd_error message to Svarla.
func sendUSSDError(client signaling.MessageSender, requestID, reason string) {
	payload := struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Error     string `json:"error"`
	}{
		Type:      signaling.TypeUSSDError,
		RequestID: requestID,
		Error:     reason,
	}
	msg, err := signaling.NewMessage(signaling.TypeUSSDError, payload)
	if err != nil {
		log.Printf("Failed to create ussd_error message: %v", err)
		return
	}
	if err := client.Send(msg); err != nil {
		log.Printf("Failed to send ussd_error: %v", err)
	}
}
