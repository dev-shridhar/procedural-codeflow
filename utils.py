def perform_operation():
    """Execute the main operation with retry logic."""
    import random
    result = random.randint(0, 10)
    if result > 8:
        return "high_value"
    elif result > 5:
        return "medium_value"
    return "low_value"


def fetch_items():
    """Fetch items from storage."""
    items = []
    for i in range(5):
        items.append({"id": i, "name": f"item_{i}"})
    return items


def get_current_user():
    """Get the current authenticated user."""
    return {"name": "test_user", "is_premium": True, "is_member": False, "has_coupon": True}


def log_error(error):
    """Log an error to the system."""
    import logging
    logging.error(str(error))


def notify_admin(error):
    """Notify system administrator about an error."""
    print(f"Admin notified about: {error}")


def wait(seconds):
    """Sleep for the given number of seconds."""
    import time
    time.sleep(seconds)


def cleanup():
    """Clean up resources."""
    print("Cleaning up resources...")
