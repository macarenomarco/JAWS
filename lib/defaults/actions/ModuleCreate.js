'use strict';

/**
 * Action: ModuleCreate
 */

const JawsPlugin = require('../../JawsPlugin'),
      JawsError  = require('../../jaws-error'),
      JawsCLI    = require('../../utils/cli'),
      fs         = require('fs'),
      path       = require('path'),
      os         = require('os'),
      BbPromise  = require('bluebird'),
      AWSUtils   = require('../../utils/aws'),
      JawsUtils  = require('../../utils');

let fs = require('fs');
BbPromise.promisifyAll(fs);

const supportedRuntimes = {
  nodejs: {
    defaultPkgMgr: 'npm',
    validPkgMgrs:  ['npm']
  }
};

/**
 * ModuleCreate Class
 */

class ModuleCreate extends JawsPlugin {

  /**
   * @param Jaws class object
   * @param config object
   */

  constructor(Jaws, config) {
    super(Jaws, config);
    this._templatesDir   = path.join(__dirname, '..', '..', 'templates');
    this._resource       = "";
    this._action         = "";
    this._pkgMgr         = false;
    this._createLambda   = false;
    this._createEndpoint = false;
    this._runtime        = 'nodejs';
  }

  /**
   * Define your plugins name
   *
   * @returns {string}
   */
  static getName() {
    return 'jaws.core.' + ModuleCreate.name;
  }

  /**
   * @returns {Promise} upon completion of all registrations
   */

  registerActions() {
    this.Jaws.action(this.createModule.bind(this), {
      handler:       'moduleCreate',
      description:   `Creates scaffolding for new aws module.
usage: jaws module create <module resource> <action>`,
      context:       'module',
      contextAction: 'create',
      options:       [
        {
          option:      'runtime',
          shortcut:    'r',
          description: ''
        },
        {
          option:      'lambda',
          shortcut:    'l',
          description: ''
        },
        {
          option:      'endpoint',
          shortcut:    'e',
          description: ''
        },
        {
          option:      'package-manager',
          shortcut:    'p',
          description: ''
        },

      ],
    });
    return Promise.resolve();
  }

  /**
   *
   * @param runtime
   * @param createLambda
   * @param createEndpoint
   * @param pkgMgr
   * @param resourceAction <array> resource action
   * @returns {Promise}
   */
  createModule(runtime, createLambda, createEndpoint, pkgMgr) {
    let _this          = this,
        resourceAction = Array.prototype.slice.call(arguments, 5);

    if (!resourceAction || resourceAction.length !== 2) {
      return Promise.reject(new JawsError('Must specify a resource and action'));
    }

    if (!createLambda && !createEndpoint) { //default is to create both
      createEndpoint = true;
      createLambda   = true;
    }

    this._resource       = resourceAction[0];
    this._action         = resourceAction[1];
    this._createEndpoint = createEndpoint;
    this._createLambda   = createLambda;
    this._runtime        = runtime || 'nodejs';

    if (!supportedRuntimes[this._runtime]) {
      throw new JawsError('Unsupported runtime ' + _this._runtime, JawsError.errorCodes.UNKNOWN);
    }

    this._pkgMgr = pkgMgr || supportedRuntimes[this._runtime].defaultPkgMgr;

    if (supportedRuntimes[this._runtime].validPkgMgrs.indexOf(this._pkgMgr) == -1) {
      throw new JawsError('Unsupported package manger "' + this._pkgMgr + '"', JawsError.errorCodes.UNKNOWN);
    }

    return this._JAWS.validateProject()
      .bind(_this)
      .then(_this._sanitizeData)
      .then(_this._createSkeleton)
      .then(_this._createPackageMgrSkeleton)
      .then(_this._initRuntime)
      .then(function() {
        JawsCLI.log('Successfully created '
          + _this._resourcee
          + '/'
          + _this._action);
      });
  }

  _sanitizeData() {
    this._action = this._action.toLowerCase().trim()
      .replace(/\s/g, '-')
      .replace(/[^a-zA-Z-\d:]/g, '')
      .substring(0, 19);

    this._resource = this._resource.toLowerCase().trim()
      .replace(/\s/g, '-')
      .replace(/[^a-zA-Z-\d:]/g, '')
      .substring(0, 19);
  }

  _generateActionAwsmJson() {
    let actionTemplateJson = utils.readAndParseJsonSync(path.join(_this._templatesDir, 'action.awsm.json'));

    //We prefix with an l to make sure the CloudFormation resource map index is unique
    actionTemplateJson.name = 'l' + this._resource.charAt(0).toUpperCase() + this._resource.slice(1) + this.action.charAt(0).toUpperCase() + this.action.slice(1);

    if (this._createLambda) {
      actionTemplateJson.cloudFormation.Lambda.Runtime = this._runtime;

      // Create files for lambda actions
      switch (this._runtime) {
        case 'nodejs':
          actionTemplateJson.cloudFormation.Lambda.Handler = path.join('aws_modules', this._resource, this._action, 'handler.handler');
          break;
        default:
          throw new JawsError('This runtime is not supported "' + this._runtime + '"', JawsError.errorCodes.UNKNOWN);
          break;
      }
    } else {
      delete actionTemplateJson.lambda;
    }

    if (this._createEndpoint) {
      actionTemplateJson.cloudFormation.APIGatewayEndpoint.Path = this._resource + '/' + this._action;
    } else {
      delete actionTemplateJson.cloudFormation.APIGatewayEndpoint;
    }

    //TODO: how do we support LambdaEventSourceMapping and LambdaAccessPolicyX
    delete actionTemplateJson.cloudFormation.LambdaEventSourceMapping;
    delete actionTemplateJson.cloudFormation.LambdaAccessPolicyX;

    return actionTemplateJson;
  }

  _generateModuleAwsmJson() {
    let moduleTemplateJson  = utils.readAndParseJsonSync(path.join(this._templatesDir, 'module.awsm.json'));
    moduleTemplateJson.name = this._resource;
    return moduleTemplateJson;
  };

  /**
   *
   * @returns {Promise}
   * @private
   */
  _createPackageMgrSkeleton() {
    let _this          = this,
        deferredWrites = [];

    switch (_this.runtime) {
      case 'nodejs':
        if (_this.pkgMgr == 'npm') {

          let modulePath = path.join(_this._JAWS._projectRootPath, 'node_modules', _this._resource);

          // Create node_module if DNE in node_modules
          if (!utils.dirExistsSync(modulePath)) {
            deferredWrites.push(fs.mkdirAsync(modulePath));
          }

          // Create module package.json if DNE in node_module
          if (!utils.fileExistsSync(path.join(modulePath, 'package.json'))) {
            let packageJsonTemplate          = utils.readAndParseJsonSync(path.join(_this._templatesDir, 'nodejs', 'package.json'));
            packageJsonTemplate.name         = _this._resource;
            packageJsonTemplate.description  = 'An aws-module';
            packageJsonTemplate.dependencies = {};

            deferredWrites.push(
              fs.writeFileAsync(path.join(modulePath, 'package.json'), JSON.stringify(packageJsonTemplate, null, 2))
            );
          }

          // Create module awsm.json if DNE in node_module
          if (!utils.fileExistsSync(path.join(modulePath, 'awsm.json'))) {
            let moduleTemplateJson = _this._generateModuleAwsmJson();
            deferredWrites.push(
              utils.writeFile(path.join(modulePath, 'awsm.json'),
                JSON.stringify(moduleTemplateJson, null, 2)));
          }

          // Create root lib folder if DNE in node_module
          let modLibPath = path.join(modulePath, 'lib');
          if (!utils.dirExistsSync(modLibPath)) {
            deferredWrites.push(fs.mkdirAsync(modLibPath));
          }

          // Create awsm folder if DNE in node_module
          if (!utils.dirExistsSync(path.join(modulePath, 'awsm'))) {
            deferredWrites.push(fs.mkdirAsync(path.join(modulePath, 'awsm')));
          }

          // Create action if DNE in node_module
          let actionPath = path.join(modulePath, 'awsm', _this.action);
          if (!utils.dirExistsSync(actionPath)) {

            let actionTemplateJson = this._generateActionAwsmJson(),
                handlerJs          = fs.readFileSync(path.join(_this._templatesDir, 'nodejs', 'handler.js')),
                indexJs            = fs.readFileSync(path.join(_this._templatesDir, 'nodejs', 'index.js'));

            deferredWrites.push(
              utils.writeFile(path.join(actionPath, 'awsm.json'), JSON.stringify(actionTemplateJson, null, 2)),
              utils.writeFile(path.join(actionPath, 'handler.js'), handlerJs),
              utils.writeFile(path.join(actionPath, 'index.js'), indexJs),
              utils.writeFile(path.join(actionPath, 'event.json'), '{}')
            );
          }
        }
        break;
      default:
        break;
    }

    return Promise.all(deferredWrites);
  }

  /**
   *
   * @returns {Promise}
   * @private
   */
  _createSkeleton() {
    let _this              = this,
        writeFilesDeferred = [];

    let modulePath = path.join(_this._JAWS._projectRootPath, 'aws_modules', _this._resource),
        actionPath = path.join(modulePath, _this.action);

    // If module/action already exists, throw error
    if (utils.dirExistsSync(actionPath)) {
      throw new JawsError(
        actionPath + ' already exists',
        JawsError.errorCodes.INVALID_PROJECT_JAWS
      );
    }

    //module path will get created by util.writeFile if DNE

    // If module awsm.json doesn't exist, create it
    if (!utils.fileExistsSync(path.join(modulePath, 'awsm.json'))) {
      let moduleTemplateJson = _this._generateModuleAwsmJson();
      writeFilesDeferred.push(
        utils.writeFile(
          path.join(modulePath, 'awsm.json'),
          JSON.stringify(moduleTemplateJson, null, 2)
        )
      );
    }

    // Create action folder
    writeFilesDeferred.push(actionPath);

    // Create action awsm.json
    let actionTemplateJson = _this._generateActionAwsmJson();


    let handlerJs = fs.readFileSync(path.join(this._templatesDir, 'nodejs', 'handler.js')),
        indexJs   = fs.readFileSync(path.join(this._templatesDir, 'nodejs', 'index.js'));

    writeFilesDeferred.push(
      utils.writeFile(path.join(actionPath, 'handler.js'), handlerJs),
      utils.writeFile(path.join(actionPath, 'index.js'), indexJs),
      utils.writeFile(path.join(actionPath, 'event.json'), '{}'),
      utils.writeFile(path.join(actionPath, 'awsm.json'), JSON.stringify(actionTemplateJson, null, 2))
    );

    return Promise.all(writeFilesDeferred);
  }

  /**
   *
   * @returns {Promise}
   * @private
   */
  _initRuntime() {
    let _this = this;

    JawsCLI.log('Preparing your runtime..');

    if (_this._runtime === 'nodejs') {
      let packageJsonTemplate  = JawsUtils.readAndParseJsonSync(path.join(_this._templatesDir, 'nodejs', 'package.json'));
      packageJsonTemplate.name = _this.Jaws._projectJson.name;
      return fs.writeFileAsync(path.join(_this.Jaws, _projectRootPath, 'package.json'), JSON.stringify(packageJsonTemplate, null, 2))
        .then(function() {
          JawsCLI.log('Installing jaws-core module...');
          JawsUtils.npmInstall(_this._projectRootPath);
        });
    }
  }
}

module.exports = ModuleCreate;