# Requirements Document

## Introduction

A personal softphone application ("vonage-softphone") that enables the user to make and receive phone calls and SMS messages using one or more Vonage-purchased phone numbers. The application runs on Android phones with a data-only plan (no cellular voice capability) and supports multi-device operation where multiple registered devices share the same call history and message data through server-side storage. The user may have multiple Vonage numbers, each with a custom label, and can select which number to use for outbound calls and messages. Notifications are delivered via UnifiedPush/ntfy, and contact resolution uses native Android device contacts. This is a single-user personal tool requiring no multi-user features.

## Glossary

- **Softphone**: The vonage-softphone application providing voice calling and SMS capabilities over data connectivity
- **Vonage_API**: The Vonage cloud telephony service providing voice and messaging APIs
- **Vonage_Numbers**: The set of one or more phone numbers purchased by the user on their Vonage account, any of which may be used for calls and messaging
- **Vonage_Number_Label**: A user-defined display name assigned to a Vonage_Number (e.g., "Personal", "Business", "Family") used to identify the number throughout the application
- **Push_Service**: The UnifiedPush/ntfy notification service already configured on the user's devices
- **Server**: The backend server hosting the database for persistent storage of call history, SMS messages, and device registration data
- **Device_Registry**: The server-side record of all registered devices associated with the user's account, used for routing notifications and managing multi-device ringing
- **Call_History**: A server-side log of all incoming, outgoing, missed, and unanswered calls with timestamps and contact information, synced to all registered devices
- **Conversation_Thread**: A grouped view of SMS messages exchanged with a single recipient, ordered chronologically, stored on the Server and synced to devices
- **Android_Contacts_Provider**: The native Android Contacts Provider API used to resolve phone numbers to contact names from the device's local contacts database
- **Registered_Device**: A device that has been authenticated and enrolled in the Device_Registry to receive notifications and participate in multi-device call routing
- **Form_Factor**: The physical form and screen characteristics of a device, categorized as Phone (compact, portrait-oriented), Tablet (large screen, landscape or portrait), or Foldable (device with a hinge that transitions between compact and expanded states)
- **Fold_State**: The current physical configuration of a Foldable device — either Folded (compact screen active) or Unfolded (expanded tablet-like screen active)
- **Adaptive_Layout**: A UI layout that restructures its content presentation based on the available screen width, transitioning between single-pane and multi-pane configurations
- **List_Detail_Layout**: A two-pane Adaptive_Layout where a list (e.g., Conversation_Threads or Call_History) is displayed alongside a detail view (e.g., an open thread or call details) side by side
- **Unanswered_Call**: An outbound call placed by the user where the destination did not answer (distinct from a Missed call, which is an inbound call that the user did not answer)
- **Material_Design_3**: Google's open-source design system providing guidelines for visual style, motion, interaction, and adaptive design across platforms
- **Dial_Pad**: A numeric keypad UI component displaying digits 0–9, the * key, the # key, and a backspace/delete button, used for manual phone number entry and DTMF tone transmission
- **DTMF_Tone**: A Dual-Tone Multi-Frequency signal sent during an active call to interact with automated phone systems (IVR menus, PIN entry, etc.)
- **App_Icon_Badge**: A numeric badge or dot indicator displayed on the application's launcher icon by the Android operating system to signal unread or unviewed items, implemented using the standard Android launcher badge API (ShortcutBadgerCompat or notification channel badge)
- **Global_Read_State**: A server-side record tracking which missed calls and messages the user has viewed, stored on the Server and synced to all Registered_Devices so that viewing items on any one device marks them as read across all devices
- **Navigation_Badge**: A visual dot or numeric indicator displayed on a bottom navigation tab within the Softphone to signal unviewed items in that tab's content

## Requirements

### Requirement 1: Outbound Voice Calls

**User Story:** As the user, I want to make phone calls from my Vonage number, so that I can place calls using my primary number over a data connection.

#### Acceptance Criteria

1. WHEN the user initiates a call to a valid destination number, THE Softphone SHALL establish a voice call through the Vonage_API using the user-selected Vonage_Number from the set of Vonage_Numbers as the caller ID within 30 seconds of initiation
7. WHEN the user initiates a new call, THE Softphone SHALL display a selector allowing the user to choose which Vonage_Number to use as the caller ID, defaulting to the most recently used Vonage_Number
2. WHILE a call is active, THE Softphone SHALL provide controls to mute the microphone, enable speakerphone, and end the call
3. WHILE a call is active, THE Softphone SHALL display the elapsed call duration in HH:MM:SS format, the destination number, and the contact name from the Android_Contacts_Provider if a matching contact exists
4. IF the Vonage_API returns an error during call setup or the call is not connected within 30 seconds, THEN THE Softphone SHALL display an error message indicating the failure reason to the user and return to the idle state
5. IF the user enters a destination number that does not conform to E.164 format, THEN THE Softphone SHALL prevent call initiation and display an error message indicating the number is invalid
6. IF the data connection is lost while a call is active, THEN THE Softphone SHALL end the call, display a notification indicating the call was disconnected due to connectivity loss, and return to the idle state
8. IF the destination does not answer the outbound call within 30 seconds, THEN THE Softphone SHALL end the call attempt, display a message indicating the call was not answered, and record the call as an unanswered call in the Call_History
9. WHILE an outbound call is active on a Registered_Device using a specific Vonage_Number, THE Server SHALL mark that Vonage_Number as in-use and THE Softphone on all other Registered_Devices SHALL disable that Vonage_Number for outbound call initiation and display the Vonage_Number_Label with a status indicator showing the number is currently in use on another device
10. WHILE a call is active on any Registered_Device, THE Softphone on all other Registered_Devices SHALL display an active call indicator banner showing the remote party number and contact name if available, the Vonage_Number_Label of the Vonage_Number in use, the name of the Registered_Device handling the call, and the elapsed call duration updated in real time

### Requirement 2: Inbound Voice Calls

**User Story:** As the user, I want to receive phone calls to my Vonage number on any of my registered devices, so that people can reach me on my primary number at any time regardless of which device I have nearby.

#### Acceptance Criteria

1. WHEN an incoming call arrives at any of the Vonage_Numbers, THE Server SHALL deliver a push notification through the Push_Service to all devices in the Device_Registry, containing the caller's number, contact name if available, and the Vonage_Number_Label of the Vonage_Number that was called, and each Registered_Device SHALL play a ringtone audibly for the duration of the incoming call attempt or until the call state changes
7. WHILE displaying an incoming call notification, THE Softphone SHALL show the Vonage_Number_Label of the called Vonage_Number so the user can identify which number the caller dialed
2. WHEN the user answers the call on one Registered_Device, THE Server SHALL establish the voice connection on that device within 3 seconds and SHALL immediately send a cancellation signal to all other Registered_Devices causing them to stop ringing and dismiss the incoming call notification
3. WHEN the user taps the incoming call notification on a Registered_Device, THE Softphone SHALL open and present options to answer or decline the call
4. WHEN the user declines the call on one Registered_Device or no device answers within 30 seconds, THE Server SHALL end the inbound call attempt, send a stop-ringing signal to all Registered_Devices, and record the call as missed in the Call_History on the Server
5. IF the caller disconnects before any Registered_Device answers or declines, THEN THE Server SHALL send a cancellation signal to all Registered_Devices to stop ringing, dismiss the incoming call notification, and record the call as a missed call in the Call_History on the Server
6. IF a Registered_Device lacks data connectivity when an incoming call arrives, THEN THE Server SHALL queue a missed-call notification per offline device for delivery through the Push_Service when that specific device regains connectivity, provided no more than 5 minutes have elapsed since the original call attempt for that device
8. WHEN the user answers an inbound call on one Registered_Device, THE Server SHALL notify all other Registered_Devices that the call is active, and THE Softphone on those devices SHALL display an active call indicator showing the call is in progress on the answering device
9. WHILE an inbound call is active on a Registered_Device using a specific Vonage_Number, THE Server SHALL mark that Vonage_Number as in-use and THE Softphone on all other Registered_Devices SHALL disable that Vonage_Number for outbound call initiation until the call ends
10. WHEN an inbound call ends as missed on a Registered_Device that was online and ringing during the call attempt, THE Softphone on that device SHALL transition from the ringing UI to the idle state and THE Server SHALL NOT deliver a separate missed-call push notification to that device, and THE Server SHALL update the Call_History via the real-time sync layer so the device reflects the missed call entry
11. IF a Registered_Device was offline during an inbound call attempt and regains connectivity after the call ended but within 5 minutes of the original call attempt, THEN THE Server SHALL deliver a missed-call notification to that device through the Push_Service indicating the caller's number, contact name if available, and time of the call
12. IF a Registered_Device was offline during an inbound call attempt and regains connectivity after more than 5 minutes have elapsed since the original call attempt, THEN THE Server SHALL NOT deliver a push notification for that call to that device, and THE Softphone SHALL retrieve the missed call entry when syncing Call_History from the Server
13. IF a Registered_Device was offline during an inbound call that was answered on another Registered_Device, THEN THE Server SHALL NOT deliver any notification about that call to the offline device upon reconnection, and the call SHALL appear in the Call_History as an incoming answered call when the device syncs

### Requirement 3: Send SMS Messages

**User Story:** As the user, I want to send SMS messages from my Vonage number, so that I can text people from my primary number.

#### Acceptance Criteria

1. WHEN the user composes and sends an SMS to a valid destination number, THE Softphone SHALL transmit the message through the Vonage_API using the user-selected Vonage_Number from the set of Vonage_Numbers as the sender, store the message on the Server in the appropriate Conversation_Thread, and display the message with a pending status indicator
7. WHEN the user composes a new SMS, THE Softphone SHALL display a selector allowing the user to choose which Vonage_Number to use as the sender, defaulting to the most recently used Vonage_Number
2. WHEN the Vonage_API confirms message delivery, THE Server SHALL update the message status from pending to sent, and all Registered_Devices viewing the Conversation_Thread SHALL reflect the updated status
3. IF the Vonage_API returns a delivery failure, THEN THE Softphone SHALL display an error indicator on the message and provide an option to retry sending up to 3 additional attempts
4. THE Softphone SHALL support SMS messages containing between 1 and 1600 characters and SHALL display a live character count showing remaining characters while the user composes a message
5. IF the user attempts to send a message with an empty body or a destination number that does not match a valid phone number format, THEN THE Softphone SHALL prevent sending and display an inline validation error indicating the issue
6. IF the data connection is unavailable when the user sends a message, THEN THE Softphone SHALL queue the message for transmission when connectivity is restored and display a queued status indicator on the message

### Requirement 4: Receive SMS Messages

**User Story:** As the user, I want to receive and read SMS messages sent to my Vonage number on any of my devices, so that I can communicate via text on my primary number from any registered device.

#### Acceptance Criteria

1. WHEN an inbound SMS arrives at any of the Vonage_Numbers, THE Server SHALL store the message in the appropriate Conversation_Thread and deliver a push notification through the Push_Service to all Registered_Devices containing the sender's number, contact name if available, the Vonage_Number_Label of the Vonage_Number that received the message, and a message preview limited to the first 100 characters of the message body
7. WHEN displaying a received SMS in a Conversation_Thread, THE Softphone SHALL show the Vonage_Number_Label of the Vonage_Number that received the message alongside the message
2. WHEN the user opens the notification on a Registered_Device, THE Softphone SHALL display the full message within the appropriate Conversation_Thread and scroll to the new message
3. THE Server SHALL store all received SMS messages in a persistent database accessible from all Registered_Devices, and each Registered_Device SHALL sync and display messages in their respective Conversation_Threads in chronological order
4. WHEN an inbound SMS is delivered as multiple concatenated segments, THE Server SHALL reassemble the segments into a single complete message before storing and notifying
5. IF no Registered_Device has data connectivity when an inbound SMS is queued by the Vonage_API, THEN THE Server SHALL store the message and each Registered_Device SHALL retrieve and display the message upon connectivity restoration without user intervention
6. THE Server SHALL discard duplicate inbound messages identified by message identifier and store only one copy in the Conversation_Thread

### Requirement 5: Push Notifications

**User Story:** As the user, I want to receive push notifications for calls, messages, and events on all my registered devices, so that I am alerted in real time without keeping the app open.

#### Acceptance Criteria

1. WHEN an incoming call arrives, THE Push_Service SHALL deliver a high-priority notification to all Registered_Devices within 3 seconds of the event, displaying as a heads-up notification with sound and vibration
2. WHEN an inbound SMS arrives, THE Push_Service SHALL deliver a notification to all Registered_Devices within 5 seconds containing the sender's phone number, contact name if available, and a message preview of up to 100 characters
3. WHEN a call is missed, THE Server SHALL deliver a missed-call notification through the Push_Service to each Registered_Device that was offline during the call attempt and regains connectivity within the per-device 5-minute TTL, indicating the caller's phone number, contact name if available, and the time of the call
4. THE Softphone SHALL use the UnifiedPush/ntfy protocol for all notification delivery without requiring Google Play Services or Firebase Cloud Messaging
5. IF the Push_Service is unreachable when a notification event occurs, THEN THE Server SHALL queue the notification and deliver it within 30 seconds of the Push_Service becoming available again
6. WHEN the user opens the Softphone on a Registered_Device and views the relevant call or conversation, THE Softphone SHALL dismiss the corresponding push notification from that device's notification area
7. IF a call has already ended, THEN THE Server SHALL NOT deliver an incoming-call notification to any Registered_Device for that call, and SHALL only deliver a missed-call notification if the call was not answered and the per-device TTL of 5 minutes has not expired
8. THE Server SHALL ensure that all Registered_Devices eventually have a complete Call_History record through server-side sync regardless of whether push notifications were delivered to or received by each device

### Requirement 6: Call History

**User Story:** As the user, I want to see a history of my calls on any device, so that I can review who called me, who I called, and what calls I missed regardless of which device I am using.

#### Acceptance Criteria

1. THE Server SHALL maintain a Call_History containing all incoming, outgoing, missed, and unanswered calls, persisted in a database so that entries are accessible from all Registered_Devices
2. THE Softphone SHALL display each Call_History entry with a distinct visual indicator for the call type (incoming, outgoing, missed, or unanswered), the contact name from Android_Contacts_Provider or the phone number if no contact match exists, the date and time of the call displayed as the exact time the event occurred (e.g., "2:34 PM" or "14:34") along with the date, and for connected calls only the call duration displayed in "Xm Ys" format for calls under one hour or HH:MM:SS format for calls of one hour or longer
3. WHEN the user selects a Call_History entry, THE Softphone SHALL provide options to call back the number or send an SMS to the number
4. THE Softphone SHALL display Call_History entries in reverse chronological order with the most recent entry first
5. THE Server SHALL retain a maximum of 1000 Call_History entries and remove the oldest entries when this limit is exceeded
6. WHEN the user opens the Call_History view and no entries exist, THE Softphone SHALL display an empty state message indicating that no call history is available
7. WHEN a new call event is recorded on the Server, all Registered_Devices SHALL sync and display the updated Call_History within 10 seconds

### Requirement 7: Conversation Threads

**User Story:** As the user, I want my messages grouped by recipient in conversation threads accessible from any device, so that I can easily follow text conversations regardless of which device I am using.

#### Acceptance Criteria

1. THE Server SHALL group all SMS messages exchanged with a single phone number into one Conversation_Thread, treating phone numbers as identical after normalization to E.164 format
2. THE Softphone SHALL display a list of all Conversation_Threads sorted by the timestamp of the most recent message in each thread, showing for each entry the contact name from Android_Contacts_Provider or phone number, a preview of the most recent message truncated to 50 characters, and the timestamp of that message
3. WHEN the user opens a Conversation_Thread, THE Softphone SHALL display the most recent 100 messages in chronological order with sent messages aligned to the right side and received messages aligned to the left side of the screen
4. IF a matching contact exists in the Android_Contacts_Provider for a Conversation_Thread's phone number, THEN THE Softphone SHALL display the contact name as the thread title
5. IF no matching contact exists in the Android_Contacts_Provider for a Conversation_Thread's phone number, THEN THE Softphone SHALL display the phone number in E.164 format as the thread title
6. WHEN a new SMS message is sent or received while the corresponding Conversation_Thread is open, THE Softphone SHALL append the message to the displayed thread within 2 seconds without requiring the user to refresh or reopen the thread

### Requirement 8: Native Device Contacts

**User Story:** As the user, I want my phone numbers resolved to contact names using my device's local contacts, so that I can see who is calling or messaging without maintaining a separate contact database.

#### Acceptance Criteria

1. WHEN a call or message involves a phone number matching a contact stored in the Android_Contacts_Provider after E.164 normalization, THE Softphone SHALL display the contact's display name alongside the phone number
2. WHEN the user initiates a new call or message, THE Softphone SHALL provide a searchable contact list populated from the Android_Contacts_Provider, searchable by contact name and phone number
3. THE Softphone SHALL request the READ_CONTACTS permission from the Android operating system before accessing the Android_Contacts_Provider
4. IF the user denies the READ_CONTACTS permission, THEN THE Softphone SHALL function without contact name resolution, displaying only phone numbers in E.164 format for all calls and messages, and SHALL display a notice indicating that contact names are unavailable until the permission is granted
5. WHEN a contact is added, updated, or removed in the device's contact database, THE Softphone SHALL reflect the change in contact name resolution within 30 seconds without requiring the user to restart the application
6. THE Softphone SHALL resolve contact names locally on each Registered_Device using that device's own Android_Contacts_Provider without requiring contacts to be synced to the Server

### Requirement 9: Authentication and Device Registration

**User Story:** As the user, I want secure login to my softphone and the ability to register multiple devices, so that unauthorized people cannot access my account and I can use the app on all my devices.

#### Acceptance Criteria

1. THE Softphone SHALL require authentication before granting access to any application functionality except receiving push notifications for incoming calls and messages
2. THE Softphone SHALL support a single user account with a password requirement of at least 12 characters including at least one uppercase letter, at least one lowercase letter, at least one digit, and at least one special character from the set !@#$%^&*()-_+=[]{}|;:',.<>?/~`
3. WHILE a session is active, THE Softphone SHALL maintain the authenticated state for a configurable duration with a default of 30 days before requiring re-authentication
4. IF five consecutive failed login attempts occur, THEN THE Softphone SHALL lock the account for 15 minutes, display a message indicating the lockout duration and remaining time, and reject further login attempts until the lockout period expires
5. WHEN the user successfully authenticates, THE Softphone SHALL reset the consecutive failed login attempt counter to zero
6. THE Softphone SHALL encrypt all stored credentials, session tokens, and locally cached messages at rest
7. WHEN the user initiates a logout action, THE Softphone SHALL invalidate the current session token, remove the device from the Device_Registry, return to the login screen, and prevent access to application functionality until the user re-authenticates
8. WHEN the user successfully authenticates on a device, THE Server SHALL add the device to the Device_Registry and begin routing notifications and call signals to the newly Registered_Device
9. THE Server SHALL support a maximum of 5 Registered_Devices simultaneously in the Device_Registry per user account
10. WHEN the user views account settings, THE Softphone SHALL display a list of all Registered_Devices with an option to remotely deregister any device from the Device_Registry

### Requirement 10: Audio Management

**User Story:** As the user, I want reliable audio handling during calls, so that I can have clear conversations.

#### Acceptance Criteria

1. WHILE a call is active, THE Softphone SHALL route audio input and output through the device's currently selected audio device (earpiece, speaker, connected Bluetooth headset, or connected wired headphones)
2. WHEN the user toggles the speakerphone control, THE Softphone SHALL switch audio output between the earpiece and the device speaker within 500 milliseconds
3. WHEN an audio device connects or disconnects during a call, THE Softphone SHALL reroute audio to the highest-priority available device using the following order: wired headphones, Bluetooth headset, earpiece
4. THE Softphone SHALL request microphone and audio output permissions before initiating or accepting any call
5. IF the user denies microphone or audio permissions, THEN THE Softphone SHALL display an error message indicating that permissions are required and SHALL NOT initiate or accept the call

### Requirement 11: Vonage Number Management

**User Story:** As the user, I want to manage multiple Vonage numbers with custom labels, so that I can organize my numbers by purpose and easily identify which number is involved in each call or message.

#### Acceptance Criteria

1. THE Softphone SHALL retrieve and display all phone numbers associated with the user's Vonage account from the Vonage_API
2. WHEN the user assigns a Vonage_Number_Label to a Vonage_Number, THE Server SHALL store the label and all Registered_Devices SHALL display the label wherever that Vonage_Number appears within 10 seconds
3. THE Softphone SHALL accept Vonage_Number_Labels containing between 1 and 30 characters
4. IF the user has not assigned a Vonage_Number_Label to a Vonage_Number, THEN THE Softphone SHALL display the phone number in E.164 format as the default label
5. THE Softphone SHALL provide a number management screen listing all Vonage_Numbers with their assigned Vonage_Number_Labels and options to edit each label
6. WHEN the user edits a Vonage_Number_Label, THE Softphone SHALL update the label on the Server and propagate the change to all Registered_Devices via the real-time sync layer
7. WHEN displaying a call or message event involving a Vonage_Number, THE Softphone SHALL show the Vonage_Number_Label alongside the phone number to identify which number was used
8. IF the user's Vonage account has only one Vonage_Number, THEN THE Softphone SHALL automatically select that number for outbound calls and messages without requiring user selection
9. WHEN the set of Vonage_Numbers on the user's account changes (number added or removed), THE Server SHALL detect the change and update all Registered_Devices within 60 seconds

### Requirement 12: Responsive Layout and Form Factor Support

**User Story:** As the user, I want the app to adapt its layout to my device's screen size and form factor, so that I have an optimal experience whether I am using a phone, tablet, or foldable device.

#### Acceptance Criteria

1. WHILE the Softphone is running on a Phone Form_Factor device, THE Softphone SHALL lock the screen orientation to portrait mode and SHALL NOT rotate to landscape orientation
2. WHILE the Softphone is running on a Tablet Form_Factor device, THE Softphone SHALL display an Adaptive_Layout that uses a List_Detail_Layout for Conversation_Threads and Call_History views, showing the list pane and detail pane side by side
3. WHILE the Softphone is running on a Tablet Form_Factor device, THE Softphone SHALL support both portrait and landscape orientations and SHALL adapt the List_Detail_Layout proportions to the available screen width
4. WHEN a Foldable device transitions from Folded Fold_State to Unfolded Fold_State, THE Softphone SHALL detect the change and transition to the Tablet Adaptive_Layout within 500 milliseconds without losing the current navigation state or user input
5. WHEN a Foldable device transitions from Unfolded Fold_State to Folded Fold_State, THE Softphone SHALL detect the change and transition to the Phone single-pane layout within 500 milliseconds, preserving the currently active detail view as the displayed screen
6. WHILE the Softphone is running on a device in Folded Fold_State, THE Softphone SHALL use the single-pane Phone layout with portrait-only orientation
7. THE Softphone SHALL render all UI elements correctly across screen densities from mdpi (160 dpi) to xxxhdpi (640 dpi) without clipping, overlapping, or illegible text
8. THE Softphone SHALL support a minimum screen width of 320 dp and a minimum screen height of 480 dp, and SHALL display a graceful error message on devices below this minimum indicating that the screen size is not supported
9. THE Softphone SHALL classify the device Form_Factor as Phone when the smallest screen width is less than 600 dp, and as Tablet when the smallest screen width is 600 dp or greater
10. WHILE displaying a List_Detail_Layout on a Tablet or Unfolded Foldable device, THE Softphone SHALL allocate between 30% and 40% of the screen width to the list pane and the remaining width to the detail pane


### Requirement 13: UI Design and User Experience

**User Story:** As the user, I want the app to have a polished, modern visual design with smooth interactions, so that using the softphone feels professional and enjoyable.

#### Acceptance Criteria

1. THE Softphone SHALL follow Material_Design_3 guidelines for all visual components including typography, color system, elevation, shape, and component styling
2. THE Softphone SHALL apply smooth animations and transitions when navigating between screens, expanding or collapsing UI elements, and displaying or dismissing overlays, with transition durations between 200 milliseconds and 500 milliseconds
3. THE Softphone SHALL maintain a consistent visual hierarchy using Material_Design_3 type scale for headings, body text, and labels throughout all screens
4. THE Softphone SHALL use the Material_Design_3 color system with a cohesive palette applied consistently across all components, ensuring sufficient contrast ratios of at least 4.5:1 for body text and 3:1 for large text against their backgrounds
5. THE Softphone SHALL apply consistent spacing using an 8 dp grid system and SHALL size all interactive touch targets to a minimum of 48 dp by 48 dp
6. WHILE content is loading, THE Softphone SHALL display a loading state using skeleton placeholders or a progress indicator appropriate to the content type
7. WHEN an error occurs that prevents content from displaying, THE Softphone SHALL display a dedicated error state with a clear description of the issue and an actionable retry option
8. WHEN no content exists for a view (empty Call_History, no Conversation_Threads, no search results), THE Softphone SHALL display a purposeful empty state with an illustration or icon, a descriptive message, and where applicable a call-to-action guiding the user to populate the view
9. WHEN the user performs an important interaction (answering a call, sending a message, or ending a call), THE Softphone SHALL trigger haptic feedback appropriate to the action using the Android HapticFeedbackConstants API
10. THE Softphone SHALL support a dark mode theme that applies a Material_Design_3 dark color scheme to all screens and components
11. WHEN the device system theme changes between light and dark mode, THE Softphone SHALL automatically switch its theme to match within 1 second without requiring the user to restart the application
12. THE Softphone SHALL provide an in-app theme setting allowing the user to choose between system default, always light, or always dark mode


### Requirement 14: Dial Pad

**User Story:** As the user, I want a dial pad for manually entering phone numbers, so that I can call or message numbers that are not saved in my contacts.

#### Acceptance Criteria

1. THE Softphone SHALL provide a Dial_Pad accessible from the main navigation (home screen) displaying buttons for digits 0 through 9, the * key, the # key, and a backspace/delete button arranged in a standard telephone grid layout
2. WHEN the user taps a digit, * , or # button on the Dial_Pad, THE Softphone SHALL append the corresponding character to the number entry field
3. WHEN the user taps the backspace/delete button on the Dial_Pad, THE Softphone SHALL remove the last character from the number entry field
4. WHILE the user enters digits on the Dial_Pad, THE Softphone SHALL format the displayed number in a readable grouping pattern appropriate to the detected numbering plan (e.g., +1 555 123 4567) and update the formatting after each digit entry
5. WHILE the user enters digits on the Dial_Pad, THE Softphone SHALL search the Android_Contacts_Provider for contacts whose phone numbers partially match the entered digits and display up to 5 matching contact suggestions above the number entry field
6. WHEN the user selects a contact from the suggestions list, THE Softphone SHALL populate the number entry field with the selected contact's phone number
7. WHEN the user long-presses the 0 button on the Dial_Pad for at least 500 milliseconds, THE Softphone SHALL enter a + character instead of a 0 digit to support international dialing prefix entry
8. WHEN the number entry field contains at least one digit, THE Softphone SHALL display a call button that initiates a voice call to the entered number using the currently selected Vonage_Number
9. WHEN the number entry field contains at least one digit, THE Softphone SHALL display a send SMS option that opens a new message composition screen addressed to the entered number
10. WHILE a voice call is active, THE Softphone SHALL provide an in-call Dial_Pad overlay accessible via a dedicated button on the active call screen
11. WHILE the in-call Dial_Pad overlay is open and a call is active, WHEN the user taps a digit, *, or # button, THE Softphone SHALL transmit the corresponding DTMF_Tone to the remote party through the Vonage_API within 200 milliseconds of the tap
12. WHILE the in-call Dial_Pad overlay is open, THE Softphone SHALL play a brief audible tone corresponding to the pressed key as local audio feedback when a DTMF_Tone is transmitted
13. IF the number entry field is empty and the user taps the call button, THEN THE Softphone SHALL prevent call initiation and display the most recent outbound number from Call_History in the number entry field


### Requirement 15: App Icon Badge and In-App Notification Indicators

**User Story:** As the user, I want to see a badge on the app icon and on in-app navigation tabs when I have missed calls or unread messages, so that I know there are items requiring my attention without needing to open the app or navigate to each section.

#### Acceptance Criteria

1. WHILE the Global_Read_State on the Server contains one or more missed calls that the user has not yet viewed in Call_History, THE Softphone SHALL display an App_Icon_Badge on the launcher icon of every Registered_Device
2. WHILE the Global_Read_State on the Server contains one or more unread SMS messages that the user has not yet opened in a Conversation_Thread, THE Softphone SHALL display an App_Icon_Badge on the launcher icon of every Registered_Device
3. THE Softphone SHALL set the App_Icon_Badge count to the combined total of unseen missed calls and unread messages as reported by the Server's Global_Read_State, using the Android notification channel badge approach to reflect the count on supported launchers
4. WHEN the user opens the Call_History view on any Registered_Device, THE Server SHALL mark all missed calls as viewed in the Global_Read_State and broadcast the change to all other Registered_Devices, causing every device to reduce its App_Icon_Badge count by the number of newly viewed missed calls within 10 seconds
5. WHEN the user opens a Conversation_Thread on any Registered_Device, THE Server SHALL mark all messages in that thread as read in the Global_Read_State and broadcast the change to all other Registered_Devices, causing every device to reduce its App_Icon_Badge count by the number of newly read messages within 10 seconds
6. WHEN the App_Icon_Badge count reaches zero, THE Softphone SHALL remove the App_Icon_Badge from the launcher icon on all Registered_Devices
7. WHEN the user views missed calls or opens a Conversation_Thread on any Registered_Device, THE Server SHALL update the Global_Read_State and broadcast the change to all other Registered_Devices, causing their App_Icon_Badge and Navigation_Badge to update accordingly within 10 seconds
8. WHILE the Global_Read_State on the Server contains one or more missed calls not yet viewed in Call_History, THE Softphone SHALL display a Navigation_Badge on the Call History tab in the bottom navigation bar on all Registered_Devices
9. WHILE the Global_Read_State on the Server contains one or more unread messages not yet opened in their respective Conversation_Threads, THE Softphone SHALL display a Navigation_Badge on the Messages tab in the bottom navigation bar on all Registered_Devices
10. WHEN the user opens the Call_History view on any Registered_Device, THE Softphone SHALL remove the Navigation_Badge from the Call History tab on all Registered_Devices within 10 seconds
11. WHEN the user opens a Conversation_Thread and all messages across all threads become read in the Global_Read_State, THE Softphone SHALL remove the Navigation_Badge from the Messages tab on all Registered_Devices within 10 seconds
12. THE Softphone SHALL use the standard Android launcher badge API (notification channel badges via NotificationManagerCompat) to display and update the App_Icon_Badge count, ensuring compatibility with launchers that support the standard badging protocol
