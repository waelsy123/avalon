db.getCollectionNames().forEach(function (collName) {
    // Drop all collections except system ones (indexes/profile)
    if (!collName.startsWith('system.')) {
        // Safety hat
        db[collName].drop();
    }
});
