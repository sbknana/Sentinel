// Copyright 2026, TheForge, LLC
//
// Central collector re-exports. Individual collectors are imported
// directly by the scheduler, but this file provides a convenient
// single-import point for other consumers.

const { collectAll: collectVmHealth } = require('./vm-health');
const { collectDockerAll, collectDocker, checkContainerAlerts } = require('./docker');
const { collectBackupStatus } = require('./backup');

module.exports = {
  collectVmHealth,
  collectDockerAll,
  collectDocker,
  checkContainerAlerts,
  collectBackupStatus,
};
