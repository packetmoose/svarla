package app.svarla.domain.audio

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.AudioAttributes
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * AudioRouter manages audio device selection and routing during voice calls.
 *
 * Responsibilities:
 * - Audio device selection with priority order: wired > Bluetooth > earpiece
 * - Speakerphone toggle (within 500ms)
 * - Device connect/disconnect detection during calls
 * - Microphone mute control
 * - Permission checking before call initiation/acceptance
 */
@Singleton
class AudioRouter @Inject constructor(
    @ApplicationContext private val context: Context,
    private val audioManager: AudioManager
) {

    private val _isSpeakerOn = MutableStateFlow(false)
    val isSpeakerOn: StateFlow<Boolean> = _isSpeakerOn.asStateFlow()

    private val _isMuted = MutableStateFlow(false)
    val isMuted: StateFlow<Boolean> = _isMuted.asStateFlow()

    private val _currentAudioDevice = MutableStateFlow(AudioDevice.EARPIECE)
    val currentAudioDevice: StateFlow<AudioDevice> = _currentAudioDevice.asStateFlow()

    private val _permissionState = MutableStateFlow<AudioPermissionState>(AudioPermissionState.Granted)
    val permissionState: StateFlow<AudioPermissionState> = _permissionState.asStateFlow()

    private val _availableDevices = MutableStateFlow(setOf(AudioDevice.EARPIECE))
    val availableDevices: StateFlow<Set<AudioDevice>> = _availableDevices.asStateFlow()

    private var isCallActive = false

    /** Indicates whether the current call is using the Telecom path (audio focus delegated). */
    private var isTelecomPathActive = false

    private var audioFocusRequest: AudioFocusRequest? = null

    private val audioDeviceReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                AudioManager.ACTION_HEADSET_PLUG -> handleHeadsetPlug(intent)
                BluetoothDevice.ACTION_ACL_CONNECTED -> handleBluetoothConnected()
                BluetoothDevice.ACTION_ACL_DISCONNECTED -> handleBluetoothDisconnected()
                BluetoothAdapter.ACTION_CONNECTION_STATE_CHANGED -> handleBluetoothStateChanged(intent)
            }
        }
    }

    /**
     * Checks required audio permissions (RECORD_AUDIO) and returns the permission state.
     * Must be called before initiating or accepting a call.
     */
    fun checkPermissions(): AudioPermissionState {
        val missingPermissions = mutableListOf<String>()

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED
        ) {
            missingPermissions.add(Manifest.permission.RECORD_AUDIO)
        }

        // On Android 12+, BLUETOOTH_CONNECT is needed for Bluetooth audio devices
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED
            ) {
                missingPermissions.add(Manifest.permission.BLUETOOTH_CONNECT)
            }
        }

        val state = if (missingPermissions.isEmpty()) {
            AudioPermissionState.Granted
        } else {
            AudioPermissionState.Denied(missingPermissions)
        }
        _permissionState.value = state
        return state
    }

    /**
     * Starts audio routing for an active call.
     * Registers receivers for device connect/disconnect events and selects the
     * highest-priority available audio device.
     *
     * When [telecomManaged] is `false` (Legacy_Path), requests audio focus and sets
     * MODE_IN_COMMUNICATION. When `true` (Telecom_Path), audio focus is delegated
     * to the Telecom framework and this method only handles device routing.
     *
     * IMPORTANT: On Legacy_Path, sets MODE_IN_COMMUNICATION before requesting audio
     * focus to ensure the audio system is in the correct mode for VoIP when the call
     * connects, particularly when the app is coming from background state.
     */
    fun startCallAudioRouting(telecomManaged: Boolean = false) {
        if (isCallActive) {
            if (!telecomManaged) {
                // Already routing — but re-apply audio mode in case it was lost
                // (can happen when app transitions from background to foreground)
                audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                requestAudioFocus()
            }
            return
        }

        isCallActive = true
        isTelecomPathActive = telecomManaged
        _isSpeakerOn.value = false
        _isMuted.value = false

        if (!telecomManaged) {
            // Legacy path: app manages audio focus and mode.
            // Set communication mode FIRST — WebRTC requires this mode to be active
            // before the peer connection audio tracks are established.
            // On some devices, setting mode after focus request causes silent audio
            // when the app was in the background.
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            requestAudioFocus()
        }
        // Both paths: register device receivers, detect devices, route to highest priority
        registerAudioDeviceReceivers()
        detectAvailableDevices()
        routeToHighestPriority()
    }

    /**
     * Stops audio routing when a call ends.
     * Unregisters receivers and resets audio state.
     * Only abandons audio focus and resets mode when NOT on the Telecom path,
     * since the Telecom framework manages focus on that path.
     */
    fun stopCallAudioRouting() {
        isCallActive = false
        unregisterAudioDeviceReceivers()

        if (!isTelecomPathActive) {
            abandonAudioFocus()
            audioManager.mode = AudioManager.MODE_NORMAL
        }

        isTelecomPathActive = false
        audioManager.isSpeakerphoneOn = false
        audioManager.isMicrophoneMute = false
        _isSpeakerOn.value = false
        _isMuted.value = false
        _currentAudioDevice.value = AudioDevice.EARPIECE
        _availableDevices.value = setOf(AudioDevice.EARPIECE)
    }

    /**
     * Toggles speakerphone on/off. When toggling on, audio routes to SPEAKER.
     * When toggling off, audio routes back to the highest-priority available device.
     * Switching completes within 500ms (AudioManager.setSpeakerphoneOn is synchronous).
     */
    fun toggleSpeaker() {
        if (!isCallActive) return

        val newSpeakerState = !_isSpeakerOn.value
        audioManager.isSpeakerphoneOn = newSpeakerState
        _isSpeakerOn.value = newSpeakerState

        if (newSpeakerState) {
            _currentAudioDevice.value = AudioDevice.SPEAKER
        } else {
            routeToHighestPriority()
        }
    }

    /**
     * Toggles microphone mute on/off.
     */
    fun toggleMute() {
        if (!isCallActive) return

        val newMuteState = !_isMuted.value
        audioManager.isMicrophoneMute = newMuteState
        _isMuted.value = newMuteState
    }

    /**
     * Detects currently available audio devices and updates the available set.
     */
    internal fun detectAvailableDevices() {
        val devices = mutableSetOf(AudioDevice.EARPIECE, AudioDevice.SPEAKER)

        if (isWiredHeadsetConnected()) {
            devices.add(AudioDevice.WIRED_HEADPHONES)
        }

        if (isBluetoothHeadsetConnected()) {
            devices.add(AudioDevice.BLUETOOTH)
        }

        _availableDevices.value = devices
    }

    /**
     * Routes audio to the highest-priority available device (excluding speaker).
     * Priority order: wired headphones > Bluetooth headset > earpiece.
     */
    internal fun routeToHighestPriority() {
        val target = AudioDevice.highestPriority(_availableDevices.value)
        routeToDevice(target)
    }

    /**
     * Routes audio to the specified device.
     */
    internal fun routeToDevice(device: AudioDevice) {
        // Ensure communication mode is active for audio routing to take effect
        if (isCallActive && !isTelecomPathActive && audioManager.mode != AudioManager.MODE_IN_COMMUNICATION) {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        }

        when (device) {
            AudioDevice.SPEAKER -> {
                audioManager.isBluetoothScoOn = false
                audioManager.stopBluetoothSco()
                audioManager.isSpeakerphoneOn = true
                _isSpeakerOn.value = true
            }
            AudioDevice.WIRED_HEADPHONES -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.isBluetoothScoOn = false
                _isSpeakerOn.value = false
            }
            AudioDevice.BLUETOOTH -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.isBluetoothScoOn = true
                audioManager.startBluetoothSco()
                _isSpeakerOn.value = false
            }
            AudioDevice.EARPIECE -> {
                audioManager.isSpeakerphoneOn = false
                audioManager.isBluetoothScoOn = false
                audioManager.stopBluetoothSco()
                _isSpeakerOn.value = false
            }
        }
        _currentAudioDevice.value = device
    }

    private fun handleHeadsetPlug(intent: Intent) {
        val state = intent.getIntExtra("state", 0)
        if (state == 1) {
            // Wired headset connected
            _availableDevices.value = _availableDevices.value + AudioDevice.WIRED_HEADPHONES
        } else {
            // Wired headset disconnected
            _availableDevices.value = _availableDevices.value - AudioDevice.WIRED_HEADPHONES
        }
        if (isCallActive) {
            routeToHighestPriority()
        }
    }

    private fun handleBluetoothConnected() {
        _availableDevices.value = _availableDevices.value + AudioDevice.BLUETOOTH
        if (isCallActive) {
            routeToHighestPriority()
        }
    }

    private fun handleBluetoothDisconnected() {
        _availableDevices.value = _availableDevices.value - AudioDevice.BLUETOOTH
        if (isCallActive) {
            routeToHighestPriority()
        }
    }

    private fun handleBluetoothStateChanged(intent: Intent) {
        val state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, BluetoothProfile.STATE_DISCONNECTED)
        when (state) {
            BluetoothProfile.STATE_CONNECTED -> handleBluetoothConnected()
            BluetoothProfile.STATE_DISCONNECTED -> handleBluetoothDisconnected()
        }
    }

    private fun isWiredHeadsetConnected(): Boolean {
        val audioDevices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        return audioDevices.any { device ->
            device.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                device.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                device.type == AudioDeviceInfo.TYPE_USB_HEADSET
        }
    }

    private fun isBluetoothHeadsetConnected(): Boolean {
        val audioDevices = audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
        return audioDevices.any { device ->
            device.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                device.type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
        }
    }

    private fun requestAudioFocus() {
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        val focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(audioAttributes)
            .setAcceptsDelayedFocusGain(true)
            .setOnAudioFocusChangeListener { focusChange ->
                when (focusChange) {
                    AudioManager.AUDIOFOCUS_GAIN -> {
                        // Focus granted (possibly after delay) — ensure mode is correct
                        if (isCallActive) {
                            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
                        }
                    }
                    AudioManager.AUDIOFOCUS_LOSS,
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                        // Another app took focus — for a phone call we keep going
                        Log.d("AudioRouter", "Audio focus lost (transient=$focusChange), keeping call audio active")
                    }
                }
            }
            .build()

        audioFocusRequest = focusRequest
        val result = audioManager.requestAudioFocus(focusRequest)
        Log.d("AudioRouter", "Audio focus request result: $result")
    }

    private fun abandonAudioFocus() {
        audioFocusRequest?.let { request ->
            audioManager.abandonAudioFocusRequest(request)
        }
        audioFocusRequest = null
    }

    private fun registerAudioDeviceReceivers() {
        val filter = IntentFilter().apply {
            addAction(AudioManager.ACTION_HEADSET_PLUG)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
            addAction(BluetoothAdapter.ACTION_CONNECTION_STATE_CHANGED)
        }
        context.registerReceiver(audioDeviceReceiver, filter)
    }

    private fun unregisterAudioDeviceReceivers() {
        try {
            context.unregisterReceiver(audioDeviceReceiver)
        } catch (_: IllegalArgumentException) {
            // Receiver was not registered — safe to ignore
        }
    }
}
