package app.svarla.domain.contacts

/**
 * Represents a contact resolved from the Android Contacts Provider.
 *
 * Used for displaying contact information in call screens, conversation threads,
 * call history, and search results.
 */
data class ContactInfo(
    /** The contact's display name */
    val name: String,
    /** The contact's phone number in E.164 format */
    val phoneNumber: String,
    /** URI to the contact's photo, or null if no photo is available */
    val photoUri: String? = null
)
