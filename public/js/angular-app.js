var app = angular.module('metronome', []);

app.controller('IndexController', function ($scope) {
  $scope.words = [
    'foo',
    'bar',
    'baz',
  ];
});

